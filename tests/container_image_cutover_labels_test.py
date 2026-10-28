"""Compose identity must survive an image-only cutover from a labelled image."""
import json
from pathlib import Path
import re
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts/lib/container-image-cutover.sh"
JQ = shutil.which("jq")


def label_programs():
    source = HELPER.read_text(encoding="utf-8")
    overrides = re.findall(
        r"\(\(\$original\.Config\.Labels // \{\}\) \| to_entries"
        r".*?\| from_entries\) as \$container_label_overrides",
        source, re.DOTALL,
    )
    merges = re.findall(
        r'\(\(\$target_image_labels \+ \$container_label_overrides\)\s*'
        r'\| if \$config_hash == "" then \. else '
        r'\.\["com\.docker\.compose\.config-hash"\] = \$config_hash end\)',
        source,
    )
    # The real diagnostic, create request and equivalence check each own a filter.
    if len(overrides) != 3 or len(merges) != 3:
        raise AssertionError("Expected the three existing cutover label consumers")
    return [override + " | " + merge for override, merge in zip(overrides, merges)]


class ContainerImageCutoverLabelsTest(unittest.TestCase):
    @unittest.skipUnless(JQ, "jq is required to execute the actual shell helper filters")
    def test_create_request_preserves_init_for_image_and_runtime_template_cutovers(self):
        match = re.search(
            r'if ! jq --arg image "\$\{target_image_id\}".*?'
            r'--slurpfile original "\$\{inspect_file\}" \'\n(.*?)\n'
            r'  \' "\$\{runtime_template_file\}" >"\$\{request_file\}";',
            HELPER.read_text(encoding="utf-8"), re.DOTALL,
        )
        self.assertIsNotNone(match, "Expected the real cutover create-request filter")
        for runtime_template_mode in (False, True):
            for init in (False, True):
                with self.subTest(runtime_template_mode=runtime_template_mode, init=init):
                    original = {
                        "Id": "a" * 64, "Config": {"Labels": {}},
                        "HostConfig": {"Init": not init, "PidsLimit": 1024, "NetworkMode": "fixture"},
                        "NetworkSettings": {"Networks": {}},
                    }
                    selected = json.loads(json.dumps(original))
                    selected["HostConfig"]["Init"] = init
                    if not runtime_template_mode:
                        original = selected
                    process = subprocess.run(
                        [JQ, "--arg", "image", "sha256:" + "b" * 64,
                         "--arg", "config_hash", "", "--arg", "primary_network", "",
                         "--argjson", "source_image_labels", "{}",
                         "--argjson", "target_image_labels", "{}",
                         "--argjson", "runtime_template_mode", json.dumps(runtime_template_mode),
                         "--argjson", "original", json.dumps([[original]]), match.group(1)],
                        input=json.dumps([selected]), capture_output=True, text=True, timeout=10,
                    )
                    self.assertEqual(process.returncode, 0, process.stderr)
                    host_config = json.loads(process.stdout)["HostConfig"]
                    self.assertIs(host_config["Init"], init)
                    self.assertEqual(host_config["PidsLimit"], 1024)

    def test_creation_and_both_equivalence_consumers_share_compose_preservation(self):
        programs = label_programs()
        self.assertEqual(len({re.sub(r"\s+", " ", program) for program in programs}), 1)
        for program in programs:
            self.assertIn('$entry.key | startswith("com.docker.compose.")', program)

    @unittest.skipUnless(JQ, "jq is required to execute the actual shell helper filters")
    def test_old_image_compose_labels_survive_a_new_image_without_compose_labels(self):
        compose = {
            "com.docker.compose.project": "forge-demoteam-phase2",
            "com.docker.compose.service": "forge-admin",
            "com.docker.compose.config-hash": "a" * 64,
            "com.docker.compose.container-number": "1",
            "com.docker.compose.project.working_dir": "/fixture/project",
        }
        source_labels = {
            **compose,
            "org.opencontainers.image.revision": "old-revision",
            "old-image-only": "retired",
        }
        target_labels = {
            "org.opencontainers.image.revision": "new-revision",
            "new-image-only": "added",
            "operator-label": "image-default",
        }
        original = {"Config": {"Labels": {**source_labels, "operator-label": "keep"}}}
        for consumer, program in zip(("diagnostic", "create", "equivalence"), label_programs()):
            for config_hash in ("", "b" * 64):
                with self.subTest(consumer=consumer, explicit_compose_hash=bool(config_hash)):
                    process = subprocess.run(
                        [JQ, "--null-input", "--argjson", "original", json.dumps(original),
                         "--argjson", "source_image_labels", json.dumps(source_labels),
                         "--argjson", "target_image_labels", json.dumps(target_labels),
                         "--arg", "config_hash", config_hash, program],
                        capture_output=True, text=True, timeout=10,
                    )
                    self.assertEqual(process.returncode, 0, process.stderr)
                    expected = {**target_labels, **compose, "operator-label": "keep"}
                    if config_hash:
                        expected["com.docker.compose.config-hash"] = config_hash
                    self.assertEqual(json.loads(process.stdout), expected)


if __name__ == "__main__":
    unittest.main(verbosity=2)
