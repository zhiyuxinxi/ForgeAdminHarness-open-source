#!/usr/bin/env python3
"""Run pinned non-AI source checks on an explicit set of Java files.

Exit 0: checked with no findings (or no applicable source); 1: review findings;
2: execution/input error. Native reports and logs are always retained.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools/quality"
STRUCTURE_RULES = {"CognitiveComplexity", "NcssCount", "GodClass", "TooManyMethods",
                   "CouplingBetweenObjects", "FileLengthCheck", "MethodLengthCheck"}


def review_kind(rule):
    return "structure" if rule.rsplit(".", 1)[-1] in STRUCTURE_RULES else "code"


def git(*args):
    result = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, check=True)
    return result.stdout.decode("utf-8").split("\0")


def selected_files(args):
    names = list(args.file or [])
    if args.base:
        # A verified commit object prevents options/pathspecs from becoming the baseline.
        base = git("rev-parse", "--verify", "--end-of-options", args.base + "^{commit}")[0].strip()
        names += git("diff", "--name-only", "--diff-filter=ACMR", "-z", base, "--")
        names += git("ls-files", "--others", "--exclude-standard", "-z")
    selected = []
    for name in sorted(set(n for n in names if n)):
        path = (ROOT / name).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file():
            raise ValueError(f"Input must be an existing repository file: {name}")
        if path.suffix != ".java":
            continue
        if "target" in path.relative_to(ROOT).parts:
            raise ValueError(f"Generated build output is not a source input: {name}")
        selected.append(path)
    return selected


def java_executable():
    home = os.environ.get("JAVA_HOME")
    exe = Path(home) / "bin" / ("java.exe" if os.name == "nt" else "java") if home else None
    return str(exe) if exe and exe.is_file() else (shutil.which("java") or "java")


def relative(path):
    resolved = Path(path).resolve()
    return resolved.relative_to(ROOT).as_posix() if resolved.is_relative_to(ROOT) else str(path)


def run_tool(name, command, output):
    log = output / (name + ".log")
    with log.open("w", encoding="utf-8") as stream:
        result = subprocess.run(command, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, timeout=180)
    return {"name": name, "exitCode": result.returncode, "log": relative(log)}


def parse_pmd(path):
    report = json.loads(path.read_text(encoding="utf-8"))
    errors = report.get("processingErrors", []) + report.get("configurationErrors", [])
    issues = []
    for file in report.get("files", []):
        for finding in file.get("violations", []):
            issues.append({"tool": "pmd", "path": relative(file["filename"]),
                           "line": finding["beginline"], "endLine": finding.get("endline", finding["beginline"]),
                           "rule": finding["rule"], "reviewKind": review_kind(finding["rule"]),
                           "message": finding["description"], "priority": finding["priority"],
                           "documentationUrl": finding.get("externalInfoUrl")})
    return issues, errors


def parse_checkstyle(path):
    tree = ET.parse(path)
    issues = []
    errors = []
    for file in tree.getroot().findall("file"):
        for finding in file.findall("error"):
            item = {"tool": "checkstyle", "path": relative(file.attrib["name"]),
                    "line": int(finding.get("line", "0")), "rule": finding.get("source", ""),
                    "reviewKind": review_kind(finding.get("source", "")),
                    "message": finding.get("message", ""), "severity": finding.get("severity", "error")}
            if item["rule"].endswith("Checker") or "Exception" in item["message"]:
                errors.append(item)
            else:
                issues.append(item)
    return issues, errors


def checkstyle_exit_error(code, issues, errors):
    # Checkstyle Main exits with the error-severity count after a completed audit.
    # Negative/platform-wrapped exits and mismatched counts are execution failures,
    # even when the process left a partial report containing ordinary findings.
    expected = sum(item.get("severity") == "error" for item in [*issues, *errors])
    return code != expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["fast"])
    parser.add_argument("--base", help="Compare working tree including untracked files with this commit")
    parser.add_argument("--file", action="append", help="Exact repository file; repeat for multiple files")
    args = parser.parse_args()
    if not args.base and not args.file:
        parser.error("Specify --base or --file; an implicit whole-repository scan is not supported")
    run_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    output = TOOLS / "target" / "reports" / run_id
    output.mkdir(parents=True)
    report = {"schemaVersion": 1, "mode": args.mode, "status": "error", "base": args.base,
              "tools": [], "files": [], "findings": [], "errors": [],
              "limits": ["Source analysis is not runtime, authorization, or business acceptance.",
                         "Design metrics are review signals; do not mechanically refactor unrelated code.",
                         "Bytecode, dependency, and architecture checks are not executed by fast."]}
    try:
        files = selected_files(args)
        report["files"] = [{"path": relative(p), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]
        if not files:
            report["status"] = "not_applicable"
        else:
            classpath = TOOLS / "target/runtime/classpath.txt"
            if not classpath.is_file():
                raise RuntimeError("Tool runtime missing: follow tools/quality/README.md setup; no automatic install")
            cp = classpath.read_text(encoding="utf-8").strip()
            if not cp or any(not Path(p).is_file() for p in cp.split(os.pathsep)):
                raise RuntimeError("Tool classpath is incomplete; preserve cache and rerun dependency preparation")
            filelist = output / "files.txt"
            filelist.write_text("\n".join(str(p) for p in files) + "\n", encoding="utf-8")
            java = [java_executable(), "-Dfile.encoding=UTF-8", "-cp", cp]
            pmd_output = output / "pmd.json"
            pmd = run_tool("pmd", [*java, "net.sourceforge.pmd.cli.PmdCli", "check",
                           "--file-list", str(filelist), "--rulesets", str(TOOLS / "pmd.xml"),
                           "--format", "json", "--report-file", str(pmd_output), "--use-version", "java-17",
                           "--cache", str(TOOLS / "target/pmd-cache"), "--no-progress"], output)
            report["tools"].append(pmd)
            if pmd["exitCode"] not in (0, 4):
                report["errors"].append({"tool": "pmd", "exitCode": pmd["exitCode"]})
            if pmd_output.is_file():
                issues, errors = parse_pmd(pmd_output)
                report["findings"] += issues
                report["errors"] += errors
            else:
                report["errors"].append("PMD did not produce a report")
            # Small batches avoid the Windows command-line limit without widening source scope.
            for start in range(0, len(files), 20):
                name = f"checkstyle-{start // 20}"
                native = output / (name + ".xml")
                result = run_tool(name, [*java, "com.puppycrawl.tools.checkstyle.Main", "-c",
                                  str(TOOLS / "checkstyle.xml"), "-f", "xml", "-o", str(native),
                                  *map(str, files[start:start + 20])], output)
                report["tools"].append(result)
                if not native.is_file():
                    report["errors"].append({"tool": name, "error": "Missing native report", "exitCode": result["exitCode"]})
                    continue
                issues, errors = parse_checkstyle(native)
                report["findings"] += issues
                report["errors"] += errors
                if checkstyle_exit_error(result["exitCode"], issues, errors):
                    report["errors"].append({"tool": name, "exitCode": result["exitCode"]})
            report["status"] = "error" if report["errors"] else "findings" if report["findings"] else "passed"
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, ET.ParseError) as error:
        report["errors"].append(str(error))
    report["findingCounts"] = {kind: sum(item["reviewKind"] == kind for item in report["findings"])
                               for kind in ("structure", "code")}
    (output / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "files": len(report["files"]),
                      "findings": len(report["findings"]), "errors": len(report["errors"]),
                      "report": relative(output / "result.json")}, ensure_ascii=False))
    return 2 if report["status"] == "error" else 1 if report["findings"] else 0


if __name__ == "__main__":
    sys.exit(main())
