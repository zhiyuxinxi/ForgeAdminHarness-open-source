import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

function source(relativePath) {
  return readFileSync(path.join(repositoryRoot, ...relativePath.split('/')), 'utf8');
}

test('GLM provider is versioned, secret-backed, and propagated to every TaskSpace', () => {
  const settings = source('templates/project/harness-settings.yaml');
  const projectCompose = source('templates/project/compose.yaml');
  const taskspaceCompose = source('templates/taskspace/compose.yaml');
  const startup = source('docker/harness/start-harness.sh');
  const environmentTemplate = source('templates/project/project.env.tpl');
  const createProject = source('scripts/create-project.sh');
  const taskspaceControl = source('scripts/taskspacectl.sh');
  const upgrade = source('scripts/upgrade-project-material-isolation.sh');
  const secretInstaller = source('scripts/install-glm-provider-secret.sh');
  const providerUpgrade = source('scripts/upgrade-glm-provider.sh');

  assert.match(settings, /zhipu:\s*\n\s+displayName: 智谱 GLM\s*\n\s+apiKeyEnv: GLM_API_KEY\s*\n\s+api: openai-completions\s*\n\s+baseURL: https:\/\/open\.bigmodel\.cn\/api\/paas\/v4[\s\S]*?- id: glm-5\.3[\s\S]*?contextWindow: 128000/u);
  assert.match(startup, /glm_key_file=\/run\/secrets\/glm-api-key[\s\S]*?export GLM_API_KEY/u);
  assert.match(environmentTemplate, /^GLM_KEY_FILE=__GLM_KEY_FILE__$/mu);
  assert.match(createProject, /__GLM_KEY_FILE__\/\$\{GLM_KEY_FILE\}/u);
  assert.match(taskspaceControl, /^GLM_KEY_FILE=\$\(env_value GLM_KEY_FILE\)$/mu);

  assert.match(projectCompose, /secrets:\s*\n\s+- deepseek-api-key\s*\n\s+- kimi-api-key\s*\n\s+- glm-api-key/u);
  assert.match(projectCompose, /GLM_KEY_FILE:\?GLM_KEY_FILE is required\}:\$\{GLM_KEY_FILE:\?GLM_KEY_FILE is required\}:ro/u);
  assert.match(projectCompose, /glm-api-key:\s*\n\s+file: \$\{GLM_KEY_FILE:\?GLM_KEY_FILE is required\}/u);
  assert.match(taskspaceCompose, /secrets:\s*\n\s+- deepseek-api-key\s*\n\s+- kimi-api-key\s*\n\s+- glm-api-key/u);
  assert.match(taskspaceCompose, /glm-api-key:\s*\n\s+file: \$\{GLM_KEY_FILE:\?GLM_KEY_FILE is required\}/u);

  const broker = projectCompose.match(/^  taskspace-broker:\s*$.*?(?=^networks:)/msu)?.[0] ?? '';
  assert.doesNotMatch(broker, /glm-api-key|GLM_KEY_FILE|docker\.sock/u);
  assert.match(upgrade, /GLM API key must be a non-empty root:root mode-0600 regular secret/u);
  assert.match(upgrade, /upsert_env "\$\{env_file\}" GLM_KEY_FILE/u);
  assert.match(upgrade, /upsert_env "\$\{task_env\}" GLM_KEY_FILE/u);
  assert.match(upgrade, /harness-settings\/project\.settings\.yaml/u);
  assert.match(secretInstaller, /\[\[ -t 0 \]\]/u);
  assert.match(secretInstaller, /Paste GLM API key \(input is hidden\)/u);
  assert.doesNotMatch(secretInstaller, /--api-key|GLM_API_KEY=/u);
  assert.match(providerUpgrade, /--confirm-maintenance-window glm-provider/u);
  assert.match(providerUpgrade, /upgrade-forge-delivery-toolkit\.sh/u);
});
