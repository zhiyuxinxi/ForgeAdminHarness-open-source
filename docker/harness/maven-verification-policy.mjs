import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const MAVEN_VERIFICATION_SETTINGS_PATH = '/usr/local/lib/maven-verification-settings.xml';
export const MAVEN_VERIFICATION_EXEC_PATH = '/usr/local/bin/maven-verification-exec';
export const MAVEN_VERIFICATION_JANSI_TMPDIR = '/tmp/forge-maven-jansi';
export const MAVEN_VERIFICATION_OPTS = `-Djansi.tmpdir=${MAVEN_VERIFICATION_JANSI_TMPDIR}`;
export const MAVEN_VERIFICATION_ENV_ARG = `MAVEN_OPTS=${MAVEN_VERIFICATION_OPTS}`;
export const MAVEN_VERIFICATION_ARGS = Object.freeze([
  '--strict-checksums',
  '--settings',
  MAVEN_VERIFICATION_SETTINGS_PATH,
]);

const SETTINGS_FILE = fileURLToPath(new URL('./maven-verification-settings.xml', import.meta.url));
const POLICY_SCHEMA = 'forge-maven-verification-acquisition/v1';
const CENTRAL_URL = 'https://repo.maven.apache.org/maven2';
const SPRING_MILESTONE_URL = 'https://repo.spring.io/milestone';
const EXACT_PUBLIC_REPOSITORY_IDS = Object.freeze(['central', 'aliyun', 'public']);

function occurrences(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1].trim());
}

export function validateMavenVerificationSettings(text) {
  if (/<(?:servers?|proxies?)\b/iu.test(text)
    || /<(?:username|password|privateKey|passphrase)\b/iu.test(text)
    || /\$\{/u.test(text)) {
    throw new Error('Maven verification settings must not contain credentials, proxies, or interpolation.');
  }
  const mirrors = occurrences(text, /<mirrorOf>([^<]+)<\/mirrorOf>/giu);
  if (mirrors.length !== 1 || mirrors[0] !== EXACT_PUBLIC_REPOSITORY_IDS.join(',')
    || mirrors[0].includes('*') || mirrors[0].includes('external:')) {
    throw new Error('Maven verification settings must mirror only the reviewed public repository IDs.');
  }
  if (!text.includes('<id>forge-central-public</id>')
    || !text.includes(`<url>${CENTRAL_URL}</url>`)
    || !text.includes('<id>spring-milestones</id>')
    || !text.includes(`<url>${SPRING_MILESTONE_URL}</url>`)
    || !text.includes('<id>spring-snapshots</id>')) {
    throw new Error('Maven verification settings repository allowlist is incomplete.');
  }
  const checksumPolicies = occurrences(text, /<checksumPolicy>([^<]+)<\/checksumPolicy>/giu);
  if (checksumPolicies.length < 6 || checksumPolicies.some((entry) => entry !== 'fail')) {
    throw new Error('Every enabled Maven verification repository must fail on checksum errors.');
  }
  const snapshotBlocks = occurrences(text, /<snapshots>([\s\S]*?)<\/snapshots>/giu);
  if (snapshotBlocks.length < 7 || snapshotBlocks.some((entry) => !/<enabled>\s*false\s*<\/enabled>/iu.test(entry))) {
    throw new Error('Maven verification snapshots must be disabled by default.');
  }
}

export async function readMavenVerificationPolicy() {
  const bytes = await readFile(SETTINGS_FILE);
  const text = bytes.toString('utf8');
  validateMavenVerificationSettings(text);
  const descriptor = {
    schemaVersion: POLICY_SCHEMA,
    settingsPath: MAVEN_VERIFICATION_SETTINGS_PATH,
    settingsSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    strictChecksums: true,
    credentials: 'forbidden',
    publicRepositoryMirror: {
      id: 'forge-central-public',
      mirrorOf: [...EXACT_PUBLIC_REPOSITORY_IDS],
      url: CENTRAL_URL,
    },
    allowedReleaseRepositories: [
      { id: 'forge-central-public', url: CENTRAL_URL, checksumPolicy: 'fail' },
      { id: 'spring-milestones', url: SPRING_MILESTONE_URL, checksumPolicy: 'fail' },
    ],
    snapshots: 'disabled-by-default',
    runtime: {
      execPath: MAVEN_VERIFICATION_EXEC_PATH,
      jansiTmpdir: MAVEN_VERIFICATION_JANSI_TMPDIR,
      jansiTmpdirMode: '0700',
      mavenOpts: MAVEN_VERIFICATION_OPTS,
      lifecycle: 'fresh-per-command-and-container-ephemeral',
      forbiddenFallbackPrefixes: ['/home/', '/workspace/', '/warm/', '/verify-cache/'],
    },
  };
  return {
    descriptor,
    digest: crypto.createHash('sha256').update(JSON.stringify(descriptor), 'utf8').digest('hex'),
  };
}
