
### 3. Update Status to Archived

Call `igris_brief_update` with `project` (the current project slug), `brief_id`
(the brief being archived) and status='Archived'. `project` and `brief_id` are
REQUIRED — a call omitting either is rejected at the gateway (BR-080). **If this
call is rejected, STOP and report the rejection — do NOT proceed to steps 4-5**,
which would leave the brief half-archived. No file move needed -- cache
auto-updates.

