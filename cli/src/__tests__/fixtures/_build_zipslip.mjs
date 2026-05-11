// _build_zipslip.mjs — emit a malicious zip-slip tarball.
//
// Used by build-tarballs.sh. Argv[2] = output path. We assemble a
// gzipped tar archive manually using the classic ustar header so we
// can include unsafe entry names that GNU tar refuses to write.
//
// Two unsafe entries:
//   - `../etc/passwd`              (parent-dir escape)
//   - `/tmp/igris-zip-slip-pwn`    (absolute path)
// Plus one innocent entry inside `igris-ai-fixturesha/core/` to prove
// that a zip-slip-rejecting fetcher rejects the WHOLE archive even when
// one entry is benign — partial extraction must not happen.

import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const out = process.argv[2];
if (!out) {
  process.stderr.write("usage: _build_zipslip.mjs <out.tar.gz>\n");
  process.exit(2);
}

function tarHeader(name, size) {
  const buf = Buffer.alloc(512);
  // name (100 bytes)
  buf.write(name.slice(0, 100), 0, 100, "utf-8");
  // mode/uid/gid — octal strings, NUL-terminated within 8-byte field
  buf.write("0000644\0", 100, 8, "utf-8");
  buf.write("0001750\0", 108, 8, "utf-8");
  buf.write("0001750\0", 116, 8, "utf-8");
  // size (12 bytes, 11 octal digits + space)
  buf.write(size.toString(8).padStart(11, "0") + " ", 124, 12, "utf-8");
  // mtime (12 bytes)
  const mtime = Math.floor(Date.now() / 1000);
  buf.write(mtime.toString(8).padStart(11, "0") + " ", 136, 12, "utf-8");
  // chksum placeholder — eight spaces for now; we compute below
  buf.write("        ", 148, 8, "utf-8");
  // typeflag '0' = regular file
  buf.write("0", 156, 1, "utf-8");
  // ustar magic (POSIX): "ustar\0" + version "00"
  buf.write("ustar\0", 257, 6, "utf-8");
  buf.write("00", 263, 2, "utf-8");
  // Compute checksum (sum of all bytes treating chksum as 8 spaces)
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  const chksumStr = sum.toString(8).padStart(6, "0") + "\0 ";
  buf.write(chksumStr, 148, 8, "utf-8");
  return buf;
}

function tarEntry(name, content) {
  const data = Buffer.isBuffer(content)
    ? content
    : Buffer.from(content, "utf-8");
  const header = tarHeader(name, data.length);
  const padLen = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header, data, Buffer.alloc(padLen)]);
}

const entries = [
  tarEntry("../etc/passwd", "PWNED via ../ escape\n"),
  tarEntry("/tmp/igris-zip-slip-pwn", "PWNED via absolute path\n"),
  tarEntry(
    "igris-ai-fixturesha/core/SOUL.md",
    "# fixture (innocent file alongside zip-slip)\n",
  ),
];

const trailer = Buffer.alloc(1024);
const archive = Buffer.concat([...entries, trailer]);
const gz = gzipSync(archive);
writeFileSync(out, gz);
process.stdout.write(`emitted ${out} (${gz.length} bytes)\n`);
