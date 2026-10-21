import contextlib
import importlib.util
import io
import json
import pathlib
import runpy
import types
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
STATUS = runpy.run_path(str(ROOT / "srt-status"))
SPEC = importlib.util.spec_from_file_location("native_enable", ROOT / "scripts" / "enable-native-stats.py")
enable = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(enable)

LEGACY = """x-srt-base: &srt-base
  image: local-srt-gateway
services:
  srt-cam1:
    <<: *srt-base
    container_name: srt-cam1
    command: "srt://:21111?rcvbuf=33554432 srt://:11111?rcvbuf=33554432 "
  srt-cam2:
    <<: *srt-base
    container_name: srt-cam2
    command: "srt://:21112?rcvbuf=33554432 srt://:11112?rcvbuf=33554432 "
"""


class PatchComposeTests(unittest.TestCase):
    def test_only_target_channel_patched(self):
        argv = ["srt://:21111?rcvbuf=33554432", "srt://:11111?rcvbuf=33554432"]
        changed, already = enable.update_command(LEGACY, 1, argv)
        self.assertFalse(already)
        self.assertIn('["-stats:3000", "-statspf:json", "srt://:21111', changed)
        self.assertIn('command: "srt://:21112?', changed)
        second, already = enable.update_command(changed, 1, argv)
        self.assertTrue(already)
        self.assertEqual(changed, second)

    def test_refuse_running_config_mismatch(self):
        with self.assertRaisesRegex(ValueError, "differs"):
            enable.update_command(LEGACY, 1, ["different", "command"])

    def test_invalid_channel(self):
        with self.assertRaisesRegex(ValueError, "not found"):
            enable.update_command(LEGACY, 4, ["a", "b"])


class NativeOutputTests(unittest.TestCase):
    def test_two_independent_srt_sides(self):
        source = {"sid":101, "link":{"rtt":190}, "recv":{"packets":3000,
                  "packetsLost":23, "packetsRetransmitted":20, "packetsDropped":3,
                  "msTsbPdDelay":1000, "mbitRate":6.3}, "send":{"packets":0}}
        target = {"sid":202, "link":{"rtt":69}, "recv":{"packets":0},
                  "send":{"packets":3000,"packetsLost":5,"packetsRetransmitted":5,
                          "packetsDropped":0,"mbitRate":6.4}}
        output = "\n".join("2026-10-22T01:40:01Z " + json.dumps(obj) for obj in (source,target))
        proc = types.SimpleNamespace(stdout=output, stderr="", returncode=0)
        with mock.patch.dict(STATUS["native_snapshot"].__globals__,
                             {"cmd":lambda args,timeout=8.0: proc}):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = STATUS["native_snapshot"](1, 2)
        self.assertEqual(rc, 0)
        self.assertIn("SOURCE UDP 21111", out.getvalue())
        self.assertIn("TARGET UDP 11111", out.getvalue())
        self.assertIn("RTT=190ms", out.getvalue())
        self.assertIn("RX_TSBPD=1000ms", out.getvalue())
        self.assertIn("RTT=69ms", out.getvalue())

    def test_no_stats_does_not_claim_loss_free(self):
        proc = types.SimpleNamespace(stdout="Accepted SRT source connection", stderr="", returncode=0)
        with mock.patch.dict(STATUS["native_snapshot"].__globals__,
                             {"cmd":lambda args,timeout=8.0: proc}):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = STATUS["native_snapshot"](1)
        self.assertEqual(rc, 1)
        self.assertIn("NO STATS", out.getvalue())


if __name__ == "__main__":
    unittest.main()
