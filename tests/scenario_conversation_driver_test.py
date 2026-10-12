import importlib.util
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    'scenario_driver', Path(__file__).resolve().parents[1] / 'scripts/forge-scenario-conversation.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class ScenarioDriverTests(unittest.TestCase):
    def test_rpc_rejection_retains_bounded_message_without_retry_or_csrf(self):
        client = object.__new__(driver.Client)
        client.base = 'http://127.0.0.1:20118'
        client.csrf = 'private-csrf'
        requests = []
        def reject(url, request, headers):
            requests.append(request)
            return {'type': 'server-response', 'rpcId': request['rpcId'], 'result': {
                'ok': False, 'error': {'code': 'internal',
                    'message': 'PHASE_HOST_VERIFICATION_REQUIRED\nprivate-csrf ' + 'x' * 3000}}}
        client.http = reject
        with self.assertRaises(ValueError) as caught:
            client.rpc('session.prompt', {'text': '确认当前前端阶段'})
        message = str(caught.exception)
        self.assertIn('internal / PHASE_HOST_VERIFICATION_REQUIRED', message)
        self.assertIn('[REDACTED]', message)
        self.assertNotIn(client.csrf, message)
        self.assertNotIn('\n', message)
        self.assertLessEqual(len(message), 2100)
        self.assertEqual(len(requests), 1)

    def test_lost_submission_response_cannot_duplicate_prompt(self):
        class LostResponse:
            calls = 0
            def rpc(self, method, payload):
                if method == 'session.list':
                    return {'items': [{'sessionId': 'owned-session', 'running': False}]}
                self.calls += 1
                raise TimeoutError('response lost after the server may have accepted')
        client = LostResponse()
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            with self.assertRaises(TimeoutError):
                driver.submit_once(client, directory, 'crud-complete', 'initial',
                                   {'sessionId': 'owned-session'}, 'original request')
            with self.assertRaises(FileExistsError):
                driver.submit_once(client, directory, 'crud-complete', 'initial',
                                   {'sessionId': 'owned-session'}, 'original request')
            self.assertEqual(client.calls, 1)
            self.assertFalse((directory / 'crud-complete-initial-submission.json').exists())

    def test_running_session_does_not_bind_or_submit_a_stale_source_request(self):
        class Running:
            def rpc(inner_self, method, payload):
                self.assertEqual(method, 'session.list')
                return {'items': [{'sessionId': 'owned-session', 'running': True}]}
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            with self.assertRaisesRegex(ValueError, 'Session is running'):
                driver.submit_once(Running(), directory, 'crud-complete', 'review',
                                   {'sessionId': 'owned-session'}, 'review current source')
            self.assertEqual(list(directory.iterdir()), [])

    def test_foreign_owner_binding_never_opens_taskspace(self):
        client = object.__new__(driver.Client)
        client.actor = 'current-owner'
        client.gateway_post = lambda *args: self.fail('foreign conversation was opened')
        with self.assertRaisesRegex(ValueError, 'ownership'):
            client.bind({'actor': 'another-owner', 'conversation': {
                'title': 'A / crud-complete', 'projectSlug': 'forge-base'}},
                'forge-base', 'A / crud-complete')

    def test_open_response_cannot_redirect_credentials_to_another_host(self):
        client = object.__new__(driver.Client)
        client.actor = 'current-owner'
        client.hostname = '192.0.2.12'
        client.gateway_post = lambda *args: {'url': 'http://foreign.invalid:20110/'}
        with self.assertRaisesRegex(ValueError, 'origin'):
            client.bind({'actor': 'current-owner', 'conversation': {
                'id': 'owned', 'title': 'A / crud-complete', 'projectSlug': 'forge-base'}},
                'forge-base', 'A / crud-complete')

    def test_active_observation_checks_remote_owner_without_starting_worker(self):
        client = object.__new__(driver.Client)
        client.actor = 'current-owner'
        client.hostname = '192.0.2.12'
        client.gateway = 'http://192.0.2.12:13080'
        conversation = {'id': 'owned', 'taskId': 'task', 'title': 'A / crud-complete',
                        'projectSlug': 'forge-base', 'status': 'active'}
        client.gateway_post = lambda *args: self.fail('observation started a worker')
        def status(url):
            self.assertEqual(url, client.gateway + '/forge-gateway/api/conversations/owned/status')
            return {'conversation': conversation}
        client.http = status
        record = {'actor': client.actor, 'conversation': dict(conversation)}
        client.bind(record, 'forge-base', 'A / crud-complete', existing_origin='http://192.0.2.12:20110')
        self.assertEqual(client.base, 'http://192.0.2.12:20110')
        for field, value in [('taskId', 'foreign'), ('status', 'stopped')]:
            original = conversation[field]
            conversation[field] = value
            with self.assertRaises(ValueError):
                client.bind(record, 'forge-base', 'A / crud-complete', existing_origin='http://192.0.2.12:20110')
            conversation[field] = original
        for origin in ['http://foreign.invalid:20110', 'http://192.0.2.12:13080']:
            with self.assertRaisesRegex(ValueError, 'origin'):
                client.bind(record, 'forge-base', 'A / crud-complete', existing_origin=origin)


if __name__ == '__main__':
    unittest.main()
