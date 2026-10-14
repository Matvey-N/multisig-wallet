// Walks through the full multi-sig lifecycle on the local Hardhat network:
// deploy 2-of-3 -> fund -> submit -> confirm -> revoke -> re-confirm -> execute,
// plus an ERC20 transfer and an owner change, both approved by the owners.
//
//   npx hardhat run scripts/demo.js                  (in-process network)
//   npx hardhat run scripts/demo.js --network localhost
const { ethers, network } = require("hardhat");

const fmt = (wei) => `${ethers.formatEther(wei)} ETH`;

async function step(title) {
  console.log(`\n--- ${title} ---`);
}

async function main() {
  if (!["hardhat", "localhost"].includes(network.name)) {
    throw new Error("The demo needs several funded accounts; run it on hardhat or localhost.");
  }
  const [alice, bob, carol, dave, recipient] = await ethers.getSigners();
  const name = new Map([
    [alice.address, "Alice"], [bob.address, "Bob"], [carol.address, "Carol"],
    [dave.address, "Dave"], [recipient.address, "Recipient"],
  ]);

  await step("1. Deploy a 2-of-3 wallet (owners: Alice, Bob, Carol)");
  const wallet = await ethers.deployContract("MultiSigWallet", [
    [alice.address, bob.address, carol.address],
    2,
  ]);
  await wallet.waitForDeployment();
  const walletAddress = await wallet.getAddress();
  name.set(walletAddress, "Wallet");
  console.log("Wallet:", walletAddress);
  console.log("Owners:", (await wallet.getOwners()).map((a) => name.get(a)).join(", "));
  console.log("Required confirmations:", (await wallet.required()).toString());

  // Prints every event of a transaction receipt in a readable form
  async function show(txPromise) {
    const receipt = await (await txPromise).wait();
    for (const log of receipt.logs) {
      const parsed = wallet.interface.parseLog(log);
      if (!parsed) continue;
      const args = parsed.fragment.inputs.map((input, i) => {
        const v = parsed.args[i];
        if (typeof v === "string" && name.has(v)) return `${input.name}=${name.get(v)}`;
        if (input.name === "value" || input.name === "amount" || input.name === "balance") return `${input.name}=${fmt(v)}`;
        if (input.type === "bytes") return `${input.name}=${v.length > 12 ? v.slice(0, 12) + "..." : v}`;
        return `${input.name}=${v}`;
      });
      console.log(`  event ${parsed.name}(${args.join(", ")})`);
    }
  }

  await step("2. Fund the wallet with 5 ETH");
  await show(alice.sendTransaction({ to: walletAddress, value: ethers.parseEther("5") }));

  await step("3. Alice submits: send 1 ETH to Recipient");
  await show(wallet.connect(alice).submitTransaction(recipient.address, ethers.parseEther("1"), "0x"));

  await step("4. Alice confirms (1 of 2)");
  await show(wallet.connect(alice).confirmTransaction(0));

  await step("5. Bob tries to execute too early");
  try {
    await wallet.connect(bob).executeTransaction(0);
  } catch (e) {
    const err = wallet.interface.parseError(e.data);
    console.log(`  reverted: ${err.name}(confirmations=${err.args[1]}, required=${err.args[2]})`);
  }

  await step("6. Bob confirms (2 of 2), then changes his mind and revokes");
  await show(wallet.connect(bob).confirmTransaction(0));
  await show(wallet.connect(bob).revokeConfirmation(0));
  console.log("  confirmations now:", (await wallet.getConfirmationCount(0)).toString());

  await step("7. Carol confirms (2 of 2) and Carol executes");
  await show(wallet.connect(carol).confirmTransaction(0));
  const before = await ethers.provider.getBalance(recipient.address);
  await show(wallet.connect(carol).executeTransaction(0));
  const after = await ethers.provider.getBalance(recipient.address);
  console.log("  Recipient received:", fmt(after - before));
  console.log("  Wallet balance:    ", fmt(await ethers.provider.getBalance(walletAddress)));

  await step("8. Second execution of the same transaction is rejected");
  try {
    await wallet.connect(alice).executeTransaction(0);
  } catch (e) {
    console.log(`  reverted: ${wallet.interface.parseError(e.data).name}`);
  }

  await step("9. ERC20: the wallet sends 250 MOCK tokens");
  const token = await ethers.deployContract("MockToken");
  name.set(await token.getAddress(), "MockToken");
  await token.mint(walletAddress, 1000n);
  const data = token.interface.encodeFunctionData("transfer", [recipient.address, 250n]);
  await show(wallet.connect(bob).submitTransaction(await token.getAddress(), 0, data));
  await show(wallet.connect(alice).confirmTransaction(1));
  await show(wallet.connect(bob).confirmTransaction(1));
  await show(wallet.connect(bob).executeTransaction(1));
  console.log("  Recipient token balance:", (await token.balanceOf(recipient.address)).toString(), "MOCK");

  await step("10. Owners vote to add Dave as a fourth owner");
  const addDave = wallet.interface.encodeFunctionData("addOwner", [dave.address]);
  await show(wallet.connect(alice).submitTransaction(walletAddress, 0, addDave));
  await show(wallet.connect(alice).confirmTransaction(2));
  await show(wallet.connect(carol).confirmTransaction(2));
  await show(wallet.connect(alice).executeTransaction(2));
  console.log("  Owners now:", (await wallet.getOwners()).map((a) => name.get(a)).join(", "));

  console.log("\nDone. Transactions in the wallet:", (await wallet.getTransactionCount()).toString());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
