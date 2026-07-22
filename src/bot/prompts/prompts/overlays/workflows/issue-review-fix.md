### Issue review and fix workflow overlay

- Review the complete current issue version with a bounded medium-tier loop.
- Carry the complete stable finding set into each fix; re-fetch immediately before
  mutation and preserve owner text and history.
- After one clean medium round, run an independent high-tier confirmation.
- Any high-tier finding returns to fix then medium review-to-clean. Only a clean,
  schema-valid high confirmation can mark the issue ready for explicit publication.
