from pathlib import Path
import re
text = (Path(__file__).resolve().parents[1] / 'docker-compose.yml').read_text()
for i in range(1,11):
    assert re.search(r'(?m)^  srt-cam%d:\s*$' % i, text), f'missing cam{i}'
    assert f'srt://:{21110+i}?rcvbuf=33554432' in text, f'missing source port for cam{i}'
    assert f'srt://:{11110+i}?rcvbuf=33554432' in text, f'missing destination port for cam{i}'
assert text.count('network_mode: "host"') == 1
print('PASS: 10 source/destination port pairs')
