/*
 * Port of DriverTest/Program.cs (S7CommPlusDriver, Thomas Wiens). Ported to TypeScript.
 * Usage: npx tsx examples/driver-test.ts [ip] [password] [username]
 */
import { ItemAddress, PlcTags, S7CommPlusConnection, Softdatatype } from "../src/index.js";
import type { PlcTag } from "../src/index.js";

async function main(): Promise<void> {
  let hostIp = "192.168.1.30";
  let password = "";
  let username = "";
  console.log("Main - START");
  // IP address, password and username can be passed as arguments
  const args = process.argv.slice(2);
  if (args.length >= 1) hostIp = args[0];
  if (args.length >= 2) password = args[1];
  if (args.length >= 3) username = args[2];
  console.log("Main - Trying to connect to: " + hostIp);

  const conn = new S7CommPlusConnection();
  let res = await conn.connect(hostIp, password, username);
  if (res === 0) {
    console.log("Main - Connect done");

    // Browse the variables
    console.log("Main - Starting browse...");
    const browse = await conn.browse();
    const vars = browse.varInfoList;
    console.log("Main - Browse res=" + browse.res);

    // Read the values of all variables
    console.log("Main - Reading values of all variables");
    const taglist: PlcTag[] = [];
    for (const v of vars) {
      const t = PlcTags.tagFactory(v.name, new ItemAddress(v.accessSequence), v.softdatatype);
      if (t !== null) taglist.push(t);
    }
    res = await conn.readTags(taglist);
    if (res === 0) {
      console.log("====================== VARIABLE TABLE ======================");
      const fmt = (a: string, b: string, c: string, d: string): string =>
        a.padEnd(80) + b.padEnd(30) + c.padEnd(20) + d.padEnd(20);
      console.log(fmt("SYMBOLIC-NAME", "ACCESS-SEQUENCE", "TYPE", "QC: VALUE"));
      for (const t of taglist) {
        console.log(
          fmt(t.name, t.address.getAccessString(), Softdatatype.Types.get(t.datatype) ?? String(t.datatype), t.toString()),
        );
      }
    }

    /*
    // Test: set PLC to STOP / RUN
    await conn.setPlcOperatingState(1);
    await conn.setPlcOperatingState(3);
    */
    await conn.disconnect();
  } else {
    console.log("Main - Connect failed! res=" + res);
  }
  console.log("Main - END");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
