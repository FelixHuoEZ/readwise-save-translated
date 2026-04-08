const token = process.env.READWISE_TOKEN || process.env.RW_TOKEN;
const ids = process.argv.slice(2).filter(Boolean);

if (!token) {
  console.error("Missing READWISE_TOKEN or RW_TOKEN.");
  process.exit(1);
}

if (ids.length === 0) {
  console.error("Usage: READWISE_TOKEN=... node scripts/delete-readwise-docs.mjs <doc-id> [more-doc-ids]");
  process.exit(1);
}

const failures = [];

for (const id of ids) {
  const response = await fetch(`https://readwise.io/api/v3/delete/${id}/`, {
    method: "DELETE",
    headers: {
      Authorization: `Token ${token}`
    }
  });

  if (response.status === 204) {
    console.log(`Deleted ${id}`);
    continue;
  }

  const body = await response.text();
  failures.push({ id, status: response.status, body });
  console.error(`Failed ${id}: ${response.status} ${body}`);
}

if (failures.length > 0) {
  process.exit(1);
}
