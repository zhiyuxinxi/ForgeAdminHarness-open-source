import crypto from 'node:crypto';

export const SOURCE_QUALITY_PROFILE = 'backend-source-quality';
export const SOURCE_QUALITY_BUNDLE_SHA256 = '73d4a24de8c9231ba5b5bc47e29605aa15b2a61452e86d6666b69c7d36b286ff';
export const SOURCE_QUALITY_MAX_BYTES = 1024 * 1024;
const JAVA_FILE = /^forge-server\/(?:[A-Za-z0-9_@+.-]+\/)*[A-Za-z0-9_$.-]+\.java$/u;

export function sourceQualitySelectors(selectors = {}) {
  if (!selectors || typeof selectors !== 'object' || Array.isArray(selectors)
    || Object.keys(selectors).some(key => key !== 'files')) throw new Error('Source quality accepts only --file selectors.');
  if (!Object.hasOwn(selectors, 'files')) return {};
  if (!Array.isArray(selectors.files) || selectors.files.length < 1 || selectors.files.length > 32
    || new Set(selectors.files).size !== selectors.files.length
    || selectors.files.some(file => typeof file !== 'string' || !JAVA_FILE.test(file)
      || file.split('/').some(part => ['.', '..', 'target', '.git'].includes(part)))) {
    throw new Error('Source quality files must be up to 32 exact forge-server Java source paths.');
  }
  return { files: [...selectors.files] };
}

// Optional diagnostics reuse a current, source-bound governance/backend admission.
// They neither add a required profile nor satisfy an acceptance obligation.
export function admittedVerificationProfile(profile, profiles) {
  return Array.isArray(profiles) && (profiles.includes(profile)
    || (profile === SOURCE_QUALITY_PROFILE && profiles.some(value =>
      ['governance', 'backend-module-compile', 'backend-module-test', 'backend-test-class'].includes(value))));
}

export function validateSourceQualityReport(report, exitCode) {
  if (!report || typeof report !== 'object' || report.schemaVersion !== 1
    || report.bundleSha256 !== SOURCE_QUALITY_BUNDLE_SHA256 || report.mode !== 'fast'
    || !['passed', 'not_applicable', 'findings', 'error'].includes(report.status)
    || !Array.isArray(report.files) || !Array.isArray(report.findings) || !Array.isArray(report.errors)
    || report.files.length > 32 || Buffer.byteLength(JSON.stringify(report)) > SOURCE_QUALITY_MAX_BYTES
    || report.files.some(file => !JAVA_FILE.test(file.path ?? '')
      || file.path.split('/').some(part => ['.', '..', 'target', '.git'].includes(part))
      || !/^[0-9a-f]{64}$/u.test(file.sha256 ?? ''))) {
    throw new Error('Backend source quality report is missing or invalid.');
  }
  const wanted = report.status === 'error' ? 2 : report.status === 'findings' ? 1 : 0;
  if (exitCode !== wanted || (wanted === 0 && (report.errors.length || report.findings.length))
    || (wanted === 1 && (!report.findings.length || report.errors.length))
    || (wanted === 2 && !report.errors.length)
    || (report.status === 'not_applicable' && report.files.length !== 0)) {
    throw new Error('Backend source quality status contradicts its exit code or findings.');
  }
  return report;
}

export function sourceQualityPayload(report, exitCode) {
  validateSourceQualityReport(report, exitCode);
  return { schemaVersion: 1, reportSha256: crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex'), report };
}

export function validateSourceQualityPayload(payload, exitCode) {
  if (!payload || payload.schemaVersion !== 1
    || payload.reportSha256 !== sourceQualityPayload(payload.report, exitCode).reportSha256) {
    throw new Error('Backend source quality payload digest is invalid.');
  }
  return payload;
}
