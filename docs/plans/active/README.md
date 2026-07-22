# Active plans

Implementation plans for backlog work that's in progress or scoped but not yet
merged into `FEATURE_REQUEST.md`'s Done log. Once a plan ships, move its file
to `docs/plans/archive/` and record it in `FEATURE_REQUEST.md`.

- **`SHIPMENT_PLAN.md`** — air-gapped enclave shipment readiness. Living plan,
  updated in place as work lands (its own `## Progress tracker` is the
  at-a-glance status). Nearly all sections done; the two remaining items
  (real vLLM hardware verification, a full single-process installer
  rehearsal) are formally accepted risks blocked on real infrastructure that
  doesn't exist yet, not open work — see its `## 3. Acceptable risk for v1.0`.
  `SHIPMENT_PUNCHLIST.md`/`SHIPMENT_PUNCHLIST_REVIEW.md` alongside it are the
  source documents it was synthesized from, kept for reference. When this
  ships for real, move all three to `docs/plans/archive/`.
