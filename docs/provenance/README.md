# Source provenance

This directory records immutable source pins, history-import scope, licensing,
and verification receipts for components folded into Andromeda.

| Component | Imported source | History policy | License |
| --- | --- | --- | --- |
| Understory | `thecodacus/understory@912cfa6d4f407ffdb768bcd667bd701ccfe9ecb2` | Full ancestry through the code pin; later upstream license confirmation retained separately | Apache-2.0 |
| Frog | `marius-patrik/Frog@8ca53649` | Full branches/tags preserved before exhaustive rename | Apache-2.0 plus bundled third-party notices |
| AMS | `marius-patrik/accumulative-matrix-sweeping@c564fb9` | Full branches/tags preserved | Owner-relicensed Apache-2.0 |
| PAES | `marius-patrik/PAES@68f3bb69df81a1ecdf88cd2a7daec567ab606f27` | Public history plus recovered enterprise archival lineage at `d235ac54a13828caac6129de30892d3ff4ff53a8` | Apache-2.0 |
| Memory | `marius-patrik/Memory@af5a2e02b99cc004e30b338f60de60789ea45775` | Existing ancestry retained after reachability proof | Owner-relicensed Apache-2.0 |
| RSCode | active snapshot `d0464fac1428da154af5c4d35efa2e8d1be7c56d` | Snapshot only; private history retained as a verified private-data bundle; Code OSS orphan omitted with a receipt | Owner-relicensed Apache-2.0 for the imported owner-authored snapshot |

Pins identify import inputs, not independent packages. Folded implementation is
released only as the single Andromeda product. Exact Git object, tree, branch,
tag, LFS, and archive receipts are added as each import lands.
