// Runs the verification tests and the concurrency experiments from the command line.
//   node scripts/proofs.js            all of them
//   node scripts/proofs.js verify     just the Section 5.6 tests
const proofs = require('../src/proofs');
const { pool } = require('../src/db');

const which = process.argv[2] || 'all';
const line = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`);

async function main() {
  if (['all', 'verify'].includes(which)) {
    console.log('\n== Section 5.6 verification (rolled back) ==');
    for (const r of await proofs.runVerification()) line(r.pass, `${r.id.padEnd(8)} ${r.title}\n        -> ${r.outcome}`);
  }
  if (['all', 'double'].includes(which)) {
    console.log('\n== Experiment 1: 100 simultaneous accepts for one driver and slot ==');
    const r = await proofs.doubleBooking({ n: 100 });
    line(r.pass, `${JSON.stringify(r.counts)}; driver holds ${r.accepted_rides_for_driver} ride(s); ${r.ms} ms`);
  }
  if (['all', 'matching'].includes(which)) {
    console.log('\n== Experiment 3: 50 riders and 10 drivers at once ==');
    const r = await proofs.concurrentMatching({ riders: 50, drivers: 10 });
    line(r.pass, `matched ${r.matched}, distinct drivers ${r.distinct_drivers}, told to retry ${r.told_to_retry}, ${r.ms} ms`);
  }
  if (['all', 'explain'].includes(which)) {
    console.log('\n== Experiment 4: matching query with and without the GiST index (20k drivers) ==');
    const r = await proofs.explainMatching({ drivers: 20000 });
    line(r.pass, `without index ${r.before.execution_ms} ms, with index ${r.after.execution_ms} ms`);
    console.log('\n-- without index --\n' + r.before.plan + '\n\n-- with index --\n' + r.after.plan);
  }
  if (['all', 'isolation'].includes(which)) {
    console.log('\n== Experiment 5: READ COMMITTED vs SERIALIZABLE (50 accepts) ==');
    for (const r of await proofs.isolationLevels({ n: 50 })) line(r.pass, `${r.isolation.padEnd(15)} ${JSON.stringify(r.counts)} ${r.ms} ms`);
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
