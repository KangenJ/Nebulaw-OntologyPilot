import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const sources = ['server.mjs', 'openfoundry-dev.mjs', 'platform-extension.mjs', 'setup-local.mjs', 'public/app.js', 'public-plus/app.js', 'run-plus.mjs', 'native-dev.mjs', 'migrate-legacy.mjs', 'demo-tour.mjs', 'backup-native.mjs', 'preflight-plus.mjs', 'verify-backup.mjs',
  'public-plus/engineering-ui.js', 'public-plus/learning-ui.js', 'public-plus/access-file.js', 'public-plus/bootstrap.js', 'public-plus/native-workbench.js', 'public-plus/native-ontology-ui.js', 'public-plus/native-data-ui.js', 'public-plus/observation-import.js', 'public-plus/native-parameters-ui.js', 'public-plus/native-links-ui.js',
  'public-plus/native-learning-ui.js', 'public-plus/native-model-history-ui.js', 'public-plus/native-model-activation-ui.js', 'public-plus/native-selection-jobs-ui.js', 'public-plus/native-feedback-ui.js', 'public-plus/native-dataset-ui.js', 'public-plus/native-feedback-proposal-ui.js', 'public-plus/native-cohort-proposal-ui.js', 'public-plus/native-episode-ui.js', 'public-plus/native-training-ui.js',
  'public-plus/native-evaluation-ui.js', 'public-plus/native-evaluation-jobs-ui.js',
  'public-plus/native-model-review-ui.js', 'public-plus/native-decision-jobs-ui.js',
  'public-plus/native-actions-ui.js',
  'public-plus/native-action-review-ui.js', 'public-plus/native-action-workflow-ui.js',
  'public-plus/native-action-proposal-ui.js',
  'public-plus/native-analysis-ui.js',
  'public-plus/native-scenarios-ui.js',
  'public-plus/native-governance-ui.js',
  'public-plus/native-journey-ui.js', 'public-plus/native-journey-flow.js', 'public-plus/native-journey-mock.js',
  'public-plus/native-session.js',
  'public-plus/native-request.js',
  'public-plus/native-intake.js', 'public-plus/native-intake-ui.js',
  'public-plus/native-definition-ui.js',
  'public-plus/native-rule-ui.js',
  'public-plus/native-recipe-ui.js',
  'public-plus/native-transition-recipe-ui.js',
  'public-plus/native-complete-recipe-ui.js',
  'public-plus/ontology-suggestions.js',
  'public-plus/native-structure-ui.js',
  'public-plus/native-compute-authorization-ui.js',
  ...readdirSync(new URL('./src/', import.meta.url)).filter(file => file.endsWith('.mjs')).map(file => 'src/' + file)];
for (const source of sources) {
  const result = spawnSync(process.execPath, ['--check', source], { cwd: new URL('./', import.meta.url), stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
