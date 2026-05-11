#!/usr/bin/env python3
"""TD-087 — auto-label pairs from /tmp/td087_corpus_pairs.csv based on title content patterns.

Heuristics (CONSERVATIVE — when in doubt, leave blank or SKIP):
- TRUE_DUP if both titles share core concept stems (pre-defined patterns from corpus inspection)
- DISTINCT if cosine_full < 0.55 (very far apart)
- SKIP otherwise (let user manually label)

The auto-labels are used as a baseline; the user can override.
"""
import csv
import re
import sys

# Corpus duplicate cluster patterns. Pairs whose BOTH titles match the same
# pattern key are TRUE_DUP. Patterns derived from manual inspection of the
# top-similarity bands.
DUP_PATTERNS = [
    # sqlite-vec mutex crash cluster (rows 34, 42, 58, 67, 81, 102 — multiple rephrases of same insight)
    (r'sqlite[- ]?vec.*mutex|mutex.*sqlite[- ]?vec|sqlite-vec v0\.1\.7|short-lived node clis?.*sqlite-vec'),
    # Engine shutdown / bootEngine cluster (rows 39, 54, 70, 77, 136 — same pattern reformulated)
    (r'bootengine|engine\.shutdown|engine boot|standalone cli'),
    # Mock at I/O boundary cluster (rows 30, 38, 55, 69, 122)
    (r'mock at i/?o boundary|mock at the i/?o boundary|mock.*function.under.test|never mock'),
    # SYNC_TABLES filter cluster (rows 32, 40, 64, 124)
    (r'sync_tables.*sqlite_master|filter sync_tables|defense-?in-?depth.*sync'),
    # BR-062 verify_mirror cluster (rows 45, 59, 73, 105, 111, 121, 129)
    (r'br-062|verify_mirror|mirror byte-equality|byte-equality is verifiable|primitive output|symlink/byte-equa|symlink/mirror byte'),
    # Three-engine brain framing (rows 143, 152) — the canonical TD-087 example
    (r'three[- ]engine brain'),
    # Capture rc / set +e set -e cluster (33, 41, 109)
    (r'capture rc.*set [+]e|capture exit code.*set [+]e'),
    # Bundle test refactor cluster (43, 103)
    (r'bundle test.*refactor|test refactor.*runtime fix'),
]

def matches(title: str, pat: str) -> bool:
    return bool(re.search(pat, title.lower()))

def label_pair(title_a: str, title_b: str, cosine_full: float, cosine_norm: float) -> str:
    # Same-cluster check
    for pat in DUP_PATTERNS:
        if matches(title_a, pat) and matches(title_b, pat):
            return 'TRUE_DUP'
    # Hard-DISTINCT for very low cosines
    if cosine_full < 0.55:
        return 'DISTINCT'
    # Mid-range or unclear → leave blank for manual review
    return ''

def main():
    inp = sys.argv[1] if len(sys.argv) > 1 else '/tmp/td087_corpus_pairs.csv'
    out = sys.argv[2] if len(sys.argv) > 2 else '/tmp/td087_corpus_pairs_labeled.csv'

    with open(inp, 'r') as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    n_dup = 0
    n_distinct = 0
    n_blank = 0
    for r in rows:
        cf = float(r['cosine_full'])
        cn = float(r['cosine_normalized'])
        label = label_pair(r['title_a'], r['title_b'], cf, cn)
        r['label_blank'] = label
        if label == 'TRUE_DUP': n_dup += 1
        elif label == 'DISTINCT': n_distinct += 1
        else: n_blank += 1

    with open(out, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=reader.fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f'wrote {out}: {n_dup} TRUE_DUP, {n_distinct} DISTINCT, {n_blank} blank/SKIP')
    print(f'(labels chosen by cluster-pattern heuristic + cosine_full<0.55 hard-distinct rule)')

if __name__ == '__main__':
    main()
