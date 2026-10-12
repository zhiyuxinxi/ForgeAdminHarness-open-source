import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const cli = path.join(repositoryRoot, 'docker/harness/forge-governance');
const moduleRoot = 'forge-server/forge-business/example';

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  return result;
}

async function write(root, file, content) {
  const target = path.join(root, ...file.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-governance-local-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const args of [
    ['init', '--initial-branch=main'], ['config', 'user.name', 'Forge Governance Test'],
    ['config', 'user.email', 'forge-governance@example.invalid'],
  ]) assert.equal(run('git', args, root).status, 0);
  await write(root, '.gitkeep', 'baseline\n');
  assert.equal(run('git', ['add', '.gitkeep'], root).status, 0);
  assert.equal(run('git', ['commit', '-m', 'baseline'], root).status, 0);
  return root;
}

function audit(root) {
  const result = run(process.execPath, [cli, 'audit', '--root', root, '--base', 'HEAD', '--format', 'json'], repositoryRoot);
  assert.ok(result.stdout.trim(), result.stderr);
  return JSON.parse(result.stdout);
}

test('controller signatures stay on their method and accept only typed servlet streaming void', async t => {
  const root = await fixture(t);
  const file = `${moduleRoot}/src/main/java/example/controller/CompactController.java`;
  const source = `import jakarta.servlet.http.HttpServletResponse;
@RestController @RequestMapping("/compact")
public class CompactController {
@PostMapping("/decide") @OperationLog(module="compact") @SaCheckPermission("compact:write") public RespInfo<Map<String,Object>>decide(){return RespInfo.success();}
@PostMapping("/actual") @OperationLog(module="compact") @SaCheckPermission("compact:write") public RespInfo<Void>actual(){return RespInfo.success();}
@PostMapping("/download") @OperationLog(module="compact") @SaCheckPermission("compact:read") public void download(HttpServletResponse response){engine.export(response);}
@PostMapping("/qualified") @OperationLog(module="compact") @SaCheckPermission("compact:read") public void qualified(javax.servlet.http.HttpServletResponse response){engine.export(response);}
@PostMapping("/ordinary") @OperationLog(module="compact") @SaCheckPermission("compact:write") public void ordinary(){service.update();}
@PostMapping("/wrong") @OperationLog(module="compact") @SaCheckPermission("compact:write") public void wrong(String response){service.update();}
@PostMapping("/comment") @OperationLog(module="compact") @SaCheckPermission("compact:write") public void comment(){/* HttpServletResponse response */service.update();}
}
`;
  await write(root, file, source);
  const shadow = `${moduleRoot}/src/main/java/example/controller/ShadowController.java`;
  await write(root, shadow, `// import jakarta.servlet.http.HttpServletResponse;
@RestController @RequestMapping("/shadow") public class ShadowController {
@PostMapping("/download") @OperationLog(module="shadow") @SaCheckPermission("shadow:read") public void download(HttpServletResponse response){service.update();}
}`);
  const findings = audit(root).findings.filter(item => item.ruleId === 'BE-CONTROLLER-001' && item.message.includes('return type'));
  const lines = source.split('\n');
  const expected = ['/ordinary', '/wrong', '/comment'].map(route => ({
    file, line: lines.findIndex(line => line.includes(`("${route}")`)) + 1,
  }));
  expected.push({ file: shadow, line: 3 });
  assert.deepEqual(findings.map(({ file, line }) => ({ file, line })).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    expected.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line));
});

test('consolidated JUnit assertions associate actual class references without accepting imports or comments', async t => {
  const root = await fixture(t);
  for (const name of ['Alpha', 'Beta', 'Ghost', 'Loose']) {
    await write(root, `${moduleRoot}/src/main/java/example/${name}Controller.java`, `
@RestController @RequestMapping("/${name.toLowerCase()}") public class ${name}Controller {
@GetMapping("/one") @SaCheckPermission("sample:read") public RespInfo<Object> one(){return RespInfo.success();}
}`);
  }
  await write(root, `${moduleRoot}/src/test/java/example/EndpointContractTest.java`, `
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import example.GhostController;
class EndpointContractTest {
  // GhostController.class is not executable evidence.
  String misleading = "GhostController.class";
  static final Class<?>[] CONTROLLERS = { AlphaController.class, BetaController.class };
  @Test void endpointsHavePermissions() {
    for (Class<?> controller : CONTROLLERS) {
      assertNotNull(controller.getAnnotation(RequestMapping.class));
    }
  }
}`);
  await write(root, `${moduleRoot}/src/test/java/example/EmptySmokeTest.java`, `
import org.junit.jupiter.api.Test;
class EmptySmokeTest {
  @Test void merelyMentionsAClass() { Class<?> type = LooseController.class; }
}`);
  const names = audit(root).findings.filter(item => item.ruleId === 'QUALITY-TEST-001')
    .map(item => path.posix.basename(item.file)).sort();
  assert.deepEqual(names, ['GhostController.java', 'LooseController.java']);
});

test('consolidated JUnit constructor references require assertions in the same test body', async t => {
  const root = await fixture(t);
  for (const name of ['Asset', 'Qualified', 'Ghost', 'Loose', 'Outside', 'NoJUnit']) {
    await write(root, `${moduleRoot}/src/main/java/example/${name}Service.java`, `class ${name}Service {}`);
  }
  await write(root, `${moduleRoot}/src/test/java/example/ScopeContractTest.java`, `
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
class ScopeContractTest {
  Object outside = new OutsideService();
  @Test void scopedWrite() {
    AssetService service = new AssetService(mapper, ids, context);
    assertEquals(1, service.saveEquipment(input, false).size());
  }
  @Test void qualifiedWrite() { assertEquals(1, new example.QualifiedService().count()); }
  @Test void noAssertions() { new LooseService(); }
  @Test void misleading() {
    // new GhostService();
    String example = "new GhostService()";
    assertEquals(1, 1);
  }
}
`);
  await write(root, `${moduleRoot}/src/test/java/example/NotAnExecutableTest.java`, `
class NotAnExecutableTest { void example() { new NoJUnitService(); assertEquals(1, 1); } }
`);
  const names = audit(root).findings.filter(item => item.ruleId === 'QUALITY-TEST-001')
    .map(item => path.posix.basename(item.file)).sort();
  assert.deepEqual(names, ['GhostService.java', 'LooseService.java', 'NoJUnitService.java', 'OutsideService.java']);
});

test('local Map business delegation does not discard a persistence outcome', async t => {
  const root = await fixture(t);
  const cases = {
    BusinessService: `import java.util.Map; class BusinessService {
      Map<String,Object> save(Input input, boolean edit) { return owner.saveEquipment(input, edit); }
      void batch(Input input) { save(input, false);
        this.save(input, true); }
    }`,
    QualifiedMapService: `class QualifiedMapService {
      java.util.Map<String,Object> save(Input input, boolean edit) { return owner.saveEquipment(input, edit); }
      void batch(Input input) { save(input, false); }
    }`,
    BooleanService: 'class BooleanService { boolean save(Input input) { return true; } void batch(Input input) { save(input); } }',
    RowsService: 'class RowsService { Integer save(Input input) { return 1; } void batch(Input input) { save(input); } }',
    UnknownService: 'class UnknownService { Object save(Input input) { return null; } void batch(Input input) { save(input); } }',
    InheritedService: 'class InheritedService extends BaseService { void batch(Input input) { save(input); } }',
    ForeignService: `import java.util.Map; class ForeignService {
      Map<String,Object> save(Input input) { return Map.of(); }
      void batch(Input input) { mapper.save(input);
        super.save(input); }
    }`,
    OverloadService: `import java.util.Map; class OverloadService {
      Map<String,Object> save(Input input) { return Map.of(); }
      boolean save(Other input) { return true; }
      void batch(Other input) { save(input); }
    }`,
    WrongArityService: `import java.util.Map; class WrongArityService {
      Map<String,Object> save(Input input, boolean edit) { return Map.of(); }
      void batch(Input input) { save(input); }
    }`,
    MisleadingService: `class MisleadingService {
      // Map<String,Object> save(Input input) { return Map.of(); }
      String example = "Map<String,Object> save(Input input) { return Map.of(); }";
      void batch(Input input) { save(input); }
    }`,
  };
  for (const [name, source] of Object.entries(cases)) {
    await write(root, `${moduleRoot}/src/main/java/example/service/${name}.java`, source);
  }
  const findings = audit(root).findings.filter(item => item.ruleId === 'BE-MUTATION-001');
  const counts = Object.fromEntries(Object.keys(cases).map(name => [name,
    findings.filter(item => path.posix.basename(item.file) === `${name}.java`).length]));
  assert.deepEqual(counts, {
    BusinessService: 0, QualifiedMapService: 0, BooleanService: 1, RowsService: 1,
    UnknownService: 1, InheritedService: 1, ForeignService: 2, OverloadService: 1,
    WrongArityService: 1, MisleadingService: 1,
  });
});

test('the pagination ceiling includes fixed 100 but rejects 101 and unbounded size bypasses', async t => {
  const root = await fixture(t);
  const bodies = {
    AtLimitService: 'new Page<>(1, 100)',
    AboveLimitService: 'new Page<>(1, 101)',
    AddedLimitService: 'new Page<>(1, 100 + 1)',
    MultipliedLimitService: 'new Page<>(1, 100 * 2)',
    UnderscoreLimitService: 'new Page<>(1, 100_000)',
    ScaledService: 'new Page<>(1, pageSize * 2)',
    UnlimitedService: 'new Page<>(1, Integer.MAX_VALUE)',
  };
  for (const [name, expression] of Object.entries(bodies)) {
    await write(root, `${moduleRoot}/src/main/java/example/${name}.java`, `class ${name} { Object page(int pageSize) { return ${expression}; } }`);
  }
  const names = audit(root).findings.filter(item => item.ruleId === 'BE-PAGE-001')
    .map(item => path.posix.basename(item.file)).sort();
  assert.deepEqual(names, ['AboveLimitService.java', 'AddedLimitService.java', 'MultipliedLimitService.java', 'ScaledService.java', 'UnderscoreLimitService.java', 'UnlimitedService.java']);
});
