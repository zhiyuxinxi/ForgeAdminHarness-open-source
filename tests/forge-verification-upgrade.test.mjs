import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const toolkit = await readFile(new URL('../scripts/upgrade-forge-delivery-toolkit.sh', import.meta.url), 'utf8');
const createProject = await readFile(new URL('../scripts/create-project.sh', import.meta.url), 'utf8');
const prototype = await readFile(new URL('../scripts/upgrade-prototype-archive-support.sh', import.meta.url), 'utf8');
const cacheWarmer = await readFile(new URL('../scripts/prepare-forge-verification-cache.sh', import.meta.url), 'utf8');
const verificationTemplate = JSON.parse(await readFile(new URL('../templates/project/verification-contract.json.tpl', import.meta.url), 'utf8'));

test('prototype upgrade remains the prior generic archive/material entrypoint', () => {
  assert.match(prototype, /exec bash "\$\{SCRIPT_DIR\}\/upgrade-project-material-isolation\.sh"/);
  assert.doesNotMatch(prototype, /verification-runner|VERIFICATION_RUNNER|taskspace-generations/);
});

test('toolkit uses a narrow two-generation cutover and never delegates to material isolation', () => {
  assert.doesNotMatch(toolkit, /upgrade-project-material-isolation|upgrade-prototype-archive-support/);
  assert.match(toolkit, /generationPolicy(?:\":|:)\"new-taskspaces-only\"/);
  assert.match(toolkit, /generation(?:\":|:)\"deferred-active\"/);
  assert.match(toolkit, /upsert_env "\$\{staged_env\}" HARNESS_IMAGE "\$\{target_image_id\}"/);
  assert.match(toolkit, /upsert_env "\$\{staged_env\}" RELEASE_RUNNER_IMAGE "\$\{target_image_id\}"/);
  assert.doesNotMatch(toolkit, /upsert_env "\$\{[^}]+\}"[^\n]*task\.env/);
});

test('the shared Gateway and registered project control services use identity-preserving candidates', () => {
  const withoutRequiredServiceBootstrap = toolkit.replaceAll(
    'project_compose "${slug}" up --detach --no-deps protected-acceptance',
    '',
  ).replaceAll('project_compose "${slug}" up --detach --no-deps verification-runner', '');
  assert.match(toolkit, /project_compose "\$\{slug\}" up --detach --no-deps protected-acceptance/);
  assert.match(toolkit, /project_compose "\$\{slug\}" up --detach --no-deps verification-runner/);
  assert.doesNotMatch(withoutRequiredServiceBootstrap, /project_compose[^\n]*\bup\b|control_compose[^\n]*\bup\b/);
  assert.match(toolkit, /config --format json \\\n+\s*\| render_runtime_template_compose "\$\{gateway_template_file\}" '\["conversation-gateway"\]'/u);
  assert.match(toolkit, /control_runtime_template_compose "\$\{staged_control\}" "\$\{gateway_template_project\}" "\$\{gateway_template_file\}" create --no-build conversation-gateway/);
  assert.match(toolkit, /forge_cutover_prepare gateway[^\n]+"\$\{gateway_template_id\}"/);
  assert.equal((toolkit.match(/forge_cutover_prepare gateway/gu) ?? []).length, 1);
  assert.match(toolkit, /gateway_maintenance_contract/);
  assert.match(toolkit, /gateway_open_protocol_matches "\$\{gateway_contract\}"/);
  assert.match(toolkit, /legacy-source-maintenance-cutover-no-pre-drain-claim/);
  assert.match(toolkit, /restore_gateway_fence \|\| rollback_ok=false/);
  assert.match(toolkit, /wait_restored_gateway_open "\$\{gateway_before_id\}"/);
  assert.match(toolkit, /wait_project_service_health "\$\{slug\}" conversation-manager/);
  assert.match(toolkit, /project_compose "\$\{slug\}" config --format json \\\n+\s*\| render_runtime_template_compose "\$\{runtime_template_file\}" '\["conversation-manager","release-runner","taskspace-broker"\]'/u);
  assert.match(toolkit, /runtime_template_compose "\$\{slug\}" "\$\{runtime_template_project\}" "\$\{runtime_template_file\}" up --no-start --no-build --no-deps conversation-manager release-runner taskspace-broker/);
  assert.match(toolkit, /forge_cutover_prepare "\$\{slug\}-manager"[^\n]+"\$\{manager_template_id\}"/);
  assert.match(toolkit, /forge_cutover_prepare "\$\{slug\}-release"[^\n]+"\$\{release_template_id\}"/);
  assert.match(toolkit, /forge_cutover_prepare "\$\{slug\}-broker"[^\n]+"\$\{broker_template_id\}"/);
  assert.match(toolkit, /forge_cutover_activate "\$\{FORGE_CUTOVER_RECORD_ROOT\}\/\$\{slug\}-release\.json"/);
  assert.match(toolkit, /cleanup_runtime_template \|\| die "Compose runtime templates could not be removed/);
  assert.match(toolkit, /if \[\[ "\$\{verification_id\}" != absent \]\]/);
  assert.match(toolkit, /Existing optional Verification Runner must be running and healthy or absent/);
  assert.match(toolkit, /freeze_project_verification_modes\(\)[\s\S]*project_verification_mode\["\$\{slug\}"\]="\$\{mode\}"/u);
  assert.match(toolkit, /project_compose\(\)[\s\S]*case "\$\{mode\}" in\s+host\) compose\+=\(--file "\$\{root\}\/ops\/compose\.host-verification\.yaml"\)/u);
  assert.match(toolkit, /Host Verification requires exactly one retained, stopped legacy Verification Runner/u);
  assert.match(toolkit, /host_retained_legacy_is_stopped\(\)[\s\S]*== exited/u);
  assert.match(toolkit, /host_verification_is_ready\(\)[\s\S]*source_socket[\s\S]*controlled-source-observer/u);
  assert.match(toolkit, /if project_uses_host_verification "\$\{slug\}"; then\s+host_retained_legacy_is_stopped "\$\{slug\}" "\$\{verification_id\}"[\s\S]{0,300}else\s+if \[\[ "\$\{verification_id\}" != absent \]\]/u);
  assert.match(toolkit, /if project_uses_host_verification "\$\{slug\}"; then\s+verification_id="\$\(selected_id "\$\{slug\}" verification-runner\)"[\s\S]{0,320}else\s+if \[\[ -f "\$\{FORGE_CUTOVER_RECORD_ROOT\}\/\$\{slug\}-verification\.json" \]\]/u);
  assert.match(toolkit, /Broker cannot reach the contract-bound Host Verification Runner/u);
  assert.doesNotMatch(toolkit, /project_compose[^\n]*(?:up|stop|restart|rm|down)[^\n]*(?:forge-admin|forge-app|forge-flow|forge-ui)/);
  assert.doesNotMatch(toolkit, /task_compose[^\n]*\s(?:up|stop|restart|rm|down)(?:\s|$)/);
});

test('preserved runtimes bind container ID, state, and active TaskSpace env hash', () => {
  assert.match(toolkit, /capture_preserved_topology "\$\{backup_root\}\/preserved\.before\.tsv"/);
  assert.match(toolkit, /preserved\.before\.tsv" "\$\{backup_root\}\/preserved\.after\.tsv/);
  assert.match(toolkit, /preserved\.before\.tsv" "\$\{backup_root\}\/preserved\.committed\.tsv/);
  assert.match(toolkit, /sha256sum "\$\{DELIVERY_ROOT\}\/projects\/\$\{slug\}\/taskspaces\/\$\{task_id\}\/task\.env"/);
  assert.match(toolkit, /conversation-gateway/);
  assert.match(toolkit, /for service in forge-admin forge-app forge-flow forge-ui/);
  assert.match(toolkit, /metadata_hash="\$\(sha256sum .*metadata\.json/);
  assert.match(toolkit, /for service in harness harness-upload/);
});

test('maintenance and rollback are bounded and idempotent', () => {
  assert.match(toolkit, /taskspaces\.lock/);
  assert.match(toolkit, /release\.lock/);
  assert.match(toolkit, /maintenance\.json/);
  assert.match(toolkit, /all_runtime_ready/);
  assert.match(toolkit, /A release won the maintenance race/);
  assert.match(toolkit, /activeJobs==0/);
  assert.match(toolkit, /rollback\(\)/);
  assert.match(toolkit, /rollback\(\) \{\s+local code=\$\?\s+trap - ERR EXIT\s+set \+e/u);
  assert.match(toolkit, /runtime_inventory_exact/);
  assert.match(toolkit, /mv -- "\$\{staged_env\}" "\$\{env_file\}"/);
  assert.match(toolkit, /mv -- "\$\{staged_compose\}" "\$\{root\}\/ops\/compose\.yaml"/);
});

test('verification files are immutable-image bound and setgid owned', () => {
  assert.match(toolkit, /toolchainImage:\$image/);
  assert.match(toolkit, /install -d -m 2700/);
  assert.match(toolkit, /stat -c '%u:%g:%a'/);
  assert.match(toolkit, /TASKSPACE_BROKER_IMAGE "\$\{target_image_id\}"/);
  assert.match(toolkit, /VERIFICATION_RUNNER_IMAGE "\$\{target_image_id\}"/);
  assert.match(toolkit, /VERIFICATION_TOOLCHAIN_IMAGE "\$\{target_image_id\}"/);
});

test('verification cache packs coexist under their immutable image namespace', () => {
  assert.equal(
    verificationTemplate.cacheRoot,
    '/srv/forge-delivery/projects/__PROJECT_SLUG__/verification/cache-packs/images/__HARNESS_IMAGE_ID__',
  );
  assert.match(createProject, /harness_cache_image_id="\$\{harness_image_id#sha256:\}"/u);
  assert.match(createProject, /verification\/cache-packs\/images\/\$\{harness_cache_image_id\}/u);
  assert.match(createProject, /__HARNESS_IMAGE_ID__\/\$\{harness_cache_image_id\}/u);
  assert.match(toolkit, /target_cache_image_id="\$\{target_image_id#sha256:\}"/u);
  assert.match(toolkit, /image_cache_root="\$\{root\}\/cache-packs\/images\/\$\{target_cache_image_id\}"/u);
  assert.match(toolkit, /\.cacheRoot==\$cacheBase or \.cacheRoot==\(\$cacheBase\+"\/images\/"\+\(\.toolchainImage\|sub\("\^sha256:";""\)\)\)/u);
  assert.match(toolkit, /\.toolchainImage==\$image and \.runnerRevision==\$revision and \.cacheRoot==\$cache/u);
  assert.match(cacheWarmer, /image_cache_root="\$\{cache_root\}\/images\/\$\{toolchain_image_id\}"/u);
  assert.match(cacheWarmer, /final_pack="\$\{image_cache_root\}\/\$\{fingerprint\}"/u);
  assert.match(cacheWarmer, /contract_cache_root.*==.*image_cache_root/u);
  assert.doesNotMatch(cacheWarmer, /final_pack="\$\{cache_root\}\/\$\{fingerprint\}"/u);
  assert.match(toolkit, /if \[\[ "\$\{directory\}" == "\$\{root\}\/state" \]\]; then\s+find "\$\{directory\}"[^\n]*chmod 2700[^\n]*\s+find "\$\{directory\}"[^\n]*chmod 0600/u);
});

test('project verification contract exposes the fixed frontend lint and typecheck profiles', () => {
  assert.deepEqual(verificationTemplate.profiles, [
    'governance', 'backend-red-test', 'frontend-red-test',
    'backend-module-compile', 'backend-module-test', 'backend-test-class',
    'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build', 'frontend-h5-build',
    'changed-safe', 'full-regression',
  ]);
  assert.ok(!verificationTemplate.profiles.some((profile) => /browser|a11y/iu.test(profile)));
  assert.match(toolkit, /\.profiles==\["governance"[^\n]+"frontend-admin-test","frontend-admin-typecheck","frontend-admin-build"/u);
  assert.match(toolkit, /or \.profiles==\["governance"/u);
});

test('verification cache warming includes test-profile dependencies and publishes a read-only pack', () => {
  assert.match(cacheWarmer, /-Penable-tests -DskipTests dependency:go-offline/u);
  assert.match(cacheWarmer, /chmod -R a-w "\$\{stage\}"/u);
  assert.match(cacheWarmer, /The published verification cache pack failed its final networkless verification/u);
  assert.match(cacheWarmer, /The staged verification cache pack failed pre-publish networkless verification/u);
  assert.match(cacheWarmer, /find -P \/warm\/m2 \/warm\/pnpm -xdev ! -type f ! -type d/u);
  assert.doesNotMatch(cacheWarmer, /rm -rf -- "\$\{warm\}"/u);
  assert.ok((cacheWarmer.match(/verification-cache-tool\.mjs verify/gu) ?? []).length >= 2);
  assert.equal((cacheWarmer.match(/--ignore-scripts/gu) ?? []).length, 5);
  assert.equal((cacheWarmer.match(/ \(preinstall\|install\|postinstall\)/gu) ?? []).length, 2);
  assert.match(cacheWarmer, /expectedCommands/u);
  assert.match(cacheWarmer, /expectedTopology/u);
  assert.match(cacheWarmer, /sourceHead/u);
  assert.match(cacheWarmer, /acquisitionPolicyDigest/u);
  assert.doesNotMatch(cacheWarmer, /chmod -R go-w/u);
});

test('verification cache staging cleanup requires its random exact owner marker', () => {
  assert.match(cacheWarmer, /stage_token="\$\(openssl rand -hex 16\)"/u);
  assert.match(cacheWarmer, /stage_marker="\$\{cache_root\}\/\.incoming-\$\{fingerprint\}-\$\{stage_token\}\.owner\.json"/u);
  assert.match(cacheWarmer, /\.schemaVersion==1 and \.token==\$token and \.fingerprint==\$fingerprint and \.toolchainImage==\$image and \.compatibilityDigest==\$compatibilityDigest/u);
  assert.match(cacheWarmer, /stage_parent.*==.*cache_root_real/u);
  assert.equal((cacheWarmer.match(/rm -rf --one-file-system -- "\$\{stage\}"/gu) ?? []).length, 1);
  assert.doesNotMatch(cacheWarmer, /cleanup\(\) \{ \[\[.*rm -rf -- "\$\{stage\}"/u);
  const markerCleanup = cacheWarmer.indexOf('cleanup_cache_stage || die');
  const stageClear = cacheWarmer.lastIndexOf("stage=''");
  const markerClear = cacheWarmer.lastIndexOf("stage_marker=''");
  const tokenClear = cacheWarmer.lastIndexOf("stage_token=''");
  assert.ok(markerCleanup >= 0 && markerCleanup < stageClear && stageClear < markerClear && markerClear < tokenClear);
  assert.doesNotMatch(cacheWarmer, /rm -rf[^\n]*"\$\{warm\}"/u);
  assert.doesNotMatch(cacheWarmer, /rm -rf[^\n]*"\$\{final_pack\}"/u);
  assert.doesNotMatch(cacheWarmer, /rm -rf[^\n]*"\$\{image_cache_root\}"/u);
});


test('H5 focused default profile migration matches actual templates and preserves custom policies', async () => {
  const files = ['acceptance-service', 'verification-contract', 'host-verification-contract'];
  const templates = await Promise.all(files.map(name => readFile(new URL(`../templates/project/${name}.json.tpl`, import.meta.url), 'utf8').then(JSON.parse)));
  const defaults = templates[0].allowedVerificationProfiles;
  const block = toolkit.slice(toolkit.indexOf('migrate_acceptance_h5_test_profile() {'), toolkit.indexOf('\nprepare_acceptance_tree() {'));
  const previous = [...block.matchAll(/\.allowedVerificationProfiles == (\[[^\n]+?\])/gu)].map(match => JSON.parse(match[1]));
  assert.deepEqual(previous, [defaults.filter(x => x !== 'frontend-h5-test'), defaults.filter(x => !['frontend-h5-test','frontend-admin-typecheck'].includes(x))]);
  assert.match(block, /jq -e [^\n]+\|\| return 0/u);
  const target = JSON.parse(/\.allowedVerificationProfiles = (\[[^\n]+?\])/.exec(block)[1]);
  assert.deepEqual(target, defaults);
  assert.equal(previous.some(list => JSON.stringify(list) === JSON.stringify(target)), false, 'already-upgraded list is unchanged');
  assert.equal(previous.some(list => JSON.stringify(list) === JSON.stringify(['governance'])), false, 'custom policy is unchanged');
  assert.deepEqual(templates[1].profiles, templates[2].profiles);
  assert.equal(templates[2].profiles.filter(x => x === 'frontend-h5-test').length, 1);
});
