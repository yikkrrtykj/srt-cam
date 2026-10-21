import importlib.machinery
import importlib.util
import pathlib
import unittest
from collections import defaultdict

ROOT = pathlib.Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader('srt_status', str(ROOT / 'srt-status'))
spec = importlib.util.spec_from_loader(loader.name, loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)

class PacketParsingTest(unittest.TestCase):
    def test_wan_receive_and_send(self):
        d = defaultdict(lambda: defaultdict(int))
        mod.process_line(b'23:47:39 ens3 In IP 58.40.218.214.3456 > 178.94.14.115.21116: UDP, length 1332', d)
        mod.process_line(b'23:47:39 ens3 Out IP 178.94.14.115.11116 > 58.40.218.214.3456: UDP, length 1332', d)
        self.assertEqual(d[6]['rx'], 1332)
        self.assertEqual(d[6]['tx'], 1332)
    def test_loopback_is_counted_once(self):
        d = defaultdict(lambda: defaultdict(int))
        mod.process_line(b'23:47:39 lo In IP 178.94.14.115.11113 > 178.94.14.115.38383: UDP, length 1332', d)
        mod.process_line(b'23:47:39 lo Out IP 178.94.14.115.11113 > 178.94.14.115.38383: UDP, length 1332', d)
        self.assertEqual(d[3]['tx'], 1332)
    def test_control_packets_excluded(self):
        d = defaultdict(lambda: defaultdict(int))
        mod.process_line(b'23:47:39 ens3 Out IP 178.94.14.115.11114 > 58.40.218.214.65431: UDP, length 20', d)
        self.assertEqual(d[4]['tx'], 0)
    def test_config_defaults(self):
        c = mod.load_config('/file/that/does/not/exist')
        self.assertEqual(c['directions'], {})
        self.assertEqual(c['expected_active'], [])
        import json
        with (ROOT / 'srt-status.json').open(encoding='utf-8') as f:
            repo_default = json.load(f)
        self.assertEqual(repo_default, c)

if __name__ == '__main__':
    unittest.main()
