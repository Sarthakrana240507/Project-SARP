// What leaves the server. Internal storage paths never do, and a student never learns which other
// record a duplicate file matched.
function toClient(row, viewerRole) {
  if (!row) return row;
  const { proof_file_path, duplicate_of, ...rest } = row;
  const out = { ...rest, has_proof: Boolean(proof_file_path) };
  if (viewerRole !== 'student') out.duplicate_of = duplicate_of ?? null;
  return out;
}
const toClientList = (rows, role) => rows.map((r) => toClient(r, role));

module.exports = { toClient, toClientList };
