// Deploys MultiSigWallet.
//
// Owners and threshold come from environment variables:
//   OWNERS    comma-separated owner addresses
//   REQUIRED  number of confirmations needed (default: majority of owners)
// On the local Hardhat network, if OWNERS is not set, the first three
// built-in accounts are used with a 2-of-3 threshold.
const { ethers, network } = require("hardhat");

async function main() {
  const signers = await ethers.getSigners();
  const local = ["hardhat", "localhost"].includes(network.name);

  let owners;
  if (process.env.OWNERS) {
    owners = process.env.OWNERS.split(",").map((a) => ethers.getAddress(a.trim()));
  } else if (local) {
    owners = signers.slice(0, 3).map((s) => s.address);
  } else {
    throw new Error("Set OWNERS to a comma-separated list of owner addresses.");
  }
  const required = Number(process.env.REQUIRED || Math.floor(owners.length / 2) + 1);

  console.log("Network:  ", network.name);
  console.log("Deployer: ", signers[0].address);
  console.log("Owners:   ", owners.join(", "));
  console.log("Required: ", `${required} of ${owners.length}`);

  const wallet = await ethers.deployContract("MultiSigWallet", [owners, required]);
  await wallet.waitForDeployment();

  console.log("");
  console.log("MultiSigWallet deployed to:", await wallet.getAddress());
  console.log("Deployment transaction:    ", wallet.deploymentTransaction().hash);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
