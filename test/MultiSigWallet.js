const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("MultiSigWallet", function () {
  const ONE_ETH = ethers.parseEther("1");

  // 2-of-3 wallet funded with 10 ETH
  async function deployFixture() {
    const [owner1, owner2, owner3, outsider, recipient, newOwner] = await ethers.getSigners();
    const owners = [owner1.address, owner2.address, owner3.address];

    const wallet = await ethers.deployContract("MultiSigWallet", [owners, 2]);
    await owner1.sendTransaction({ to: await wallet.getAddress(), value: ethers.parseEther("10") });

    return { wallet, owners, owner1, owner2, owner3, outsider, recipient, newOwner };
  }

  // Submits a transaction from owner1 and returns its id.
  async function submit(wallet, signer, to, value = 0n, data = "0x") {
    const txId = await wallet.getTransactionCount();
    await wallet.connect(signer).submitTransaction(to, value, data);
    return txId;
  }

  // Runs a call on the wallet itself (owner management) through the full multi-sig flow.
  async function viaMultisig(wallet, signers, fn, args) {
    const data = wallet.interface.encodeFunctionData(fn, args);
    const txId = await submit(wallet, signers[0], await wallet.getAddress(), 0n, data);
    for (const s of signers) await wallet.connect(s).confirmTransaction(txId);
    return { txId, exec: wallet.connect(signers[0]).executeTransaction(txId) };
  }

  // ------------------------------------------------------------------
  describe("Deployment and initialization", function () {
    it("stores owners and the confirmation threshold", async function () {
      const { wallet, owners } = await loadFixture(deployFixture);
      expect(await wallet.getOwners()).to.deep.equal(owners);
      expect(await wallet.required()).to.equal(2n);
      for (const o of owners) expect(await wallet.isOwner(o)).to.equal(true);
      expect(await wallet.getTransactionCount()).to.equal(0n);
    });

    it("emits OwnerAdded for every owner and RequirementChanged", async function () {
      const [a, b] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("MultiSigWallet");
      const wallet = await Factory.deploy([a.address, b.address], 2);
      const tx = wallet.deploymentTransaction();
      await expect(tx).to.emit(wallet, "OwnerAdded").withArgs(a.address);
      await expect(tx).to.emit(wallet, "OwnerAdded").withArgs(b.address);
      await expect(tx).to.emit(wallet, "RequirementChanged").withArgs(2n);
    });

    it("rejects an empty owner list", async function () {
      const Factory = await ethers.getContractFactory("MultiSigWallet");
      await expect(Factory.deploy([], 1))
        .to.be.revertedWithCustomError(Factory, "InvalidRequirement")
        .withArgs(0n, 1n);
    });

    it("rejects a threshold of zero", async function () {
      const [a, b] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("MultiSigWallet");
      await expect(Factory.deploy([a.address, b.address], 0))
        .to.be.revertedWithCustomError(Factory, "InvalidRequirement")
        .withArgs(2n, 0n);
    });

    it("rejects a threshold above the number of owners", async function () {
      const [a, b] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("MultiSigWallet");
      await expect(Factory.deploy([a.address, b.address], 3))
        .to.be.revertedWithCustomError(Factory, "InvalidRequirement")
        .withArgs(2n, 3n);
    });

    it("rejects the zero address as an owner", async function () {
      const [a] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("MultiSigWallet");
      await expect(Factory.deploy([a.address, ethers.ZeroAddress], 1))
        .to.be.revertedWithCustomError(Factory, "InvalidOwner")
        .withArgs(ethers.ZeroAddress);
    });

    it("rejects duplicate owners", async function () {
      const [a] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("MultiSigWallet");
      await expect(Factory.deploy([a.address, a.address], 1))
        .to.be.revertedWithCustomError(Factory, "DuplicateOwner")
        .withArgs(a.address);
    });

    it("rejects more than MAX_OWNERS owners", async function () {
      const Factory = await ethers.getContractFactory("MultiSigWallet");
      const tooMany = Array.from({ length: 51 }, () => ethers.Wallet.createRandom().address);
      await expect(Factory.deploy(tooMany, 1))
        .to.be.revertedWithCustomError(Factory, "InvalidRequirement")
        .withArgs(51n, 1n);
    });
  });

  // ------------------------------------------------------------------
  describe("Deposits", function () {
    it("accepts Ether from anyone and emits Deposit", async function () {
      const { wallet, outsider } = await loadFixture(deployFixture);
      const address = await wallet.getAddress();
      await expect(outsider.sendTransaction({ to: address, value: ONE_ETH }))
        .to.emit(wallet, "Deposit")
        .withArgs(outsider.address, ONE_ETH, ethers.parseEther("11"));
      expect(await ethers.provider.getBalance(address)).to.equal(ethers.parseEther("11"));
    });
  });

  // ------------------------------------------------------------------
  describe("Submission", function () {
    it("lets an owner submit a transaction and stores it", async function () {
      const { wallet, owner1, recipient } = await loadFixture(deployFixture);

      await expect(wallet.connect(owner1).submitTransaction(recipient.address, ONE_ETH, "0x1234"))
        .to.emit(wallet, "SubmitTransaction")
        .withArgs(owner1.address, 0n, recipient.address, ONE_ETH, "0x1234");

      const [to, value, data, executed, numConfirmations] = await wallet.getTransaction(0);
      expect(to).to.equal(recipient.address);
      expect(value).to.equal(ONE_ETH);
      expect(data).to.equal("0x1234");
      expect(executed).to.equal(false);
      expect(numConfirmations).to.equal(0n);
      expect(await wallet.getTransactionCount()).to.equal(1n);
    });

    it("does not confirm the transaction automatically", async function () {
      const { wallet, owner1, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, ONE_ETH);
      expect(await wallet.isConfirmed(0, owner1.address)).to.equal(false);
    });

    it("assigns increasing transaction ids", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, 1n);
      await expect(wallet.connect(owner2).submitTransaction(recipient.address, 2n, "0x"))
        .to.emit(wallet, "SubmitTransaction")
        .withArgs(owner2.address, 1n, recipient.address, 2n, "0x");
      expect(await wallet.getTransactionCount()).to.equal(2n);
    });

    it("rejects submissions from non-owners", async function () {
      const { wallet, outsider, recipient } = await loadFixture(deployFixture);
      await expect(wallet.connect(outsider).submitTransaction(recipient.address, ONE_ETH, "0x"))
        .to.be.revertedWithCustomError(wallet, "NotOwner")
        .withArgs(outsider.address);
    });

    it("rejects the zero address as destination", async function () {
      const { wallet, owner1 } = await loadFixture(deployFixture);
      await expect(
        wallet.connect(owner1).submitTransaction(ethers.ZeroAddress, ONE_ETH, "0x")
      ).to.be.revertedWithCustomError(wallet, "InvalidDestination");
    });
  });

  // ------------------------------------------------------------------
  describe("Confirmation", function () {
    it("records confirmations from several owners", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, ONE_ETH);

      await expect(wallet.connect(owner1).confirmTransaction(0))
        .to.emit(wallet, "ConfirmTransaction")
        .withArgs(owner1.address, 0n);
      await expect(wallet.connect(owner2).confirmTransaction(0))
        .to.emit(wallet, "ConfirmTransaction")
        .withArgs(owner2.address, 0n);

      expect(await wallet.isConfirmed(0, owner1.address)).to.equal(true);
      expect(await wallet.isConfirmed(0, owner2.address)).to.equal(true);
      expect(await wallet.getConfirmationCount(0)).to.equal(2n);
      expect(await wallet.getConfirmations(0)).to.deep.equal([owner1.address, owner2.address]);
    });

    it("rejects a duplicate confirmation from the same owner", async function () {
      const { wallet, owner1, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, ONE_ETH);
      await wallet.connect(owner1).confirmTransaction(0);

      await expect(wallet.connect(owner1).confirmTransaction(0))
        .to.be.revertedWithCustomError(wallet, "TxAlreadyConfirmed")
        .withArgs(0n, owner1.address);
      expect(await wallet.getConfirmationCount(0)).to.equal(1n);
    });

    it("rejects confirmations from non-owners", async function () {
      const { wallet, owner1, outsider, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, ONE_ETH);
      await expect(wallet.connect(outsider).confirmTransaction(0))
        .to.be.revertedWithCustomError(wallet, "NotOwner")
        .withArgs(outsider.address);
    });

    it("rejects confirming a transaction that does not exist", async function () {
      const { wallet, owner1 } = await loadFixture(deployFixture);
      await expect(wallet.connect(owner1).confirmTransaction(7))
        .to.be.revertedWithCustomError(wallet, "TxDoesNotExist")
        .withArgs(7n);
    });

    it("rejects confirming an already executed transaction", async function () {
      const { wallet, owner1, owner2, owner3, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, ONE_ETH);
      await wallet.connect(owner1).confirmTransaction(0);
      await wallet.connect(owner2).confirmTransaction(0);
      await wallet.connect(owner1).executeTransaction(0);

      await expect(wallet.connect(owner3).confirmTransaction(0))
        .to.be.revertedWithCustomError(wallet, "TxAlreadyExecuted")
        .withArgs(0n);
    });
  });

  // ------------------------------------------------------------------
  describe("Revocation", function () {
    it("lets an owner revoke their own confirmation", async function () {
      const { wallet, owner1, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, ONE_ETH);
      await wallet.connect(owner1).confirmTransaction(0);

      await expect(wallet.connect(owner1).revokeConfirmation(0))
        .to.emit(wallet, "RevokeConfirmation")
        .withArgs(owner1.address, 0n);
      expect(await wallet.isConfirmed(0, owner1.address)).to.equal(false);
      expect(await wallet.getConfirmationCount(0)).to.equal(0n);
    });

    it("allows confirming again after a revocation", async function () {
      const { wallet, owner1, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, ONE_ETH);
      await wallet.connect(owner1).confirmTransaction(0);
      await wallet.connect(owner1).revokeConfirmation(0);
      await expect(wallet.connect(owner1).confirmTransaction(0)).to.emit(wallet, "ConfirmTransaction");
      expect(await wallet.getConfirmationCount(0)).to.equal(1n);
    });

    it("rejects revoking without a prior confirmation", async function () {
      const { wallet, owner1, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, ONE_ETH);
      await expect(wallet.connect(owner1).revokeConfirmation(0))
        .to.be.revertedWithCustomError(wallet, "TxNotConfirmed")
        .withArgs(0n, owner1.address);
    });

    it("does not let one owner revoke another owner's confirmation", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, ONE_ETH);
      await wallet.connect(owner1).confirmTransaction(0);

      await expect(wallet.connect(owner2).revokeConfirmation(0))
        .to.be.revertedWithCustomError(wallet, "TxNotConfirmed")
        .withArgs(0n, owner2.address);
      expect(await wallet.isConfirmed(0, owner1.address)).to.equal(true);
    });

    it("rejects revocations from non-owners", async function () {
      const { wallet, owner1, outsider, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, ONE_ETH);
      await expect(wallet.connect(outsider).revokeConfirmation(0))
        .to.be.revertedWithCustomError(wallet, "NotOwner")
        .withArgs(outsider.address);
    });

    it("rejects revoking after execution", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, ONE_ETH);
      await wallet.connect(owner1).confirmTransaction(0);
      await wallet.connect(owner2).confirmTransaction(0);
      await wallet.connect(owner1).executeTransaction(0);

      await expect(wallet.connect(owner1).revokeConfirmation(0))
        .to.be.revertedWithCustomError(wallet, "TxAlreadyExecuted")
        .withArgs(0n);
    });

    it("blocks execution when a revocation drops confirmations below the threshold", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, ONE_ETH);
      await wallet.connect(owner1).confirmTransaction(0);
      await wallet.connect(owner2).confirmTransaction(0);
      expect(await wallet.isExecutable(0)).to.equal(true);

      await wallet.connect(owner2).revokeConfirmation(0);
      expect(await wallet.isExecutable(0)).to.equal(false);
      await expect(wallet.connect(owner1).executeTransaction(0))
        .to.be.revertedWithCustomError(wallet, "NotEnoughConfirmations")
        .withArgs(0n, 1n, 2n);
    });
  });

  // ------------------------------------------------------------------
  describe("Execution", function () {
    it("sends Ether once the threshold is reached", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, ONE_ETH);
      await wallet.connect(owner1).confirmTransaction(0);
      await wallet.connect(owner2).confirmTransaction(0);

      const exec = wallet.connect(owner1).executeTransaction(0);
      await expect(exec).to.emit(wallet, "ExecuteTransaction").withArgs(owner1.address, 0n);
      await expect(exec).to.changeEtherBalances([wallet, recipient], [-ONE_ETH, ONE_ETH]);

      const [, , , executed] = await wallet.getTransaction(0);
      expect(executed).to.equal(true);
    });

    it("refuses to execute with zero confirmations", async function () {
      const { wallet, owner1, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, ONE_ETH);
      await expect(wallet.connect(owner1).executeTransaction(0))
        .to.be.revertedWithCustomError(wallet, "NotEnoughConfirmations")
        .withArgs(0n, 0n, 2n);
    });

    it("refuses to execute with fewer confirmations than required", async function () {
      const { wallet, owner1, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, ONE_ETH);
      await wallet.connect(owner1).confirmTransaction(0);
      await expect(wallet.connect(owner1).executeTransaction(0))
        .to.be.revertedWithCustomError(wallet, "NotEnoughConfirmations")
        .withArgs(0n, 1n, 2n);
      const [, , , executed] = await wallet.getTransaction(0);
      expect(executed).to.equal(false);
    });

    it("lets any owner execute, including one who did not confirm", async function () {
      const { wallet, owner1, owner2, owner3, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, ONE_ETH);
      await wallet.connect(owner1).confirmTransaction(0);
      await wallet.connect(owner2).confirmTransaction(0);
      await expect(wallet.connect(owner3).executeTransaction(0))
        .to.emit(wallet, "ExecuteTransaction")
        .withArgs(owner3.address, 0n);
    });

    it("does not let non-owners execute, even a fully confirmed transaction", async function () {
      const { wallet, owner1, owner2, outsider, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, ONE_ETH);
      await wallet.connect(owner1).confirmTransaction(0);
      await wallet.connect(owner2).confirmTransaction(0);
      await expect(wallet.connect(outsider).executeTransaction(0))
        .to.be.revertedWithCustomError(wallet, "NotOwner")
        .withArgs(outsider.address);
    });

    it("prevents executing the same transaction twice", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, ONE_ETH);
      await wallet.connect(owner1).confirmTransaction(0);
      await wallet.connect(owner2).confirmTransaction(0);
      await wallet.connect(owner1).executeTransaction(0);

      await expect(wallet.connect(owner2).executeTransaction(0))
        .to.be.revertedWithCustomError(wallet, "TxAlreadyExecuted")
        .withArgs(0n);
    });

    it("rejects executing a transaction that does not exist", async function () {
      const { wallet, owner1 } = await loadFixture(deployFixture);
      await expect(wallet.connect(owner1).executeTransaction(3))
        .to.be.revertedWithCustomError(wallet, "TxDoesNotExist")
        .withArgs(3n);
    });

    it("transfers ERC20 tokens through calldata", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployFixture);
      const token = await ethers.deployContract("MockToken");
      const walletAddress = await wallet.getAddress();
      await token.mint(walletAddress, 1000n);

      const data = token.interface.encodeFunctionData("transfer", [recipient.address, 250n]);
      await submit(wallet, owner1, await token.getAddress(), 0n, data);
      await wallet.connect(owner1).confirmTransaction(0);
      await wallet.connect(owner2).confirmTransaction(0);

      await expect(wallet.connect(owner2).executeTransaction(0)).to.changeTokenBalances(
        token,
        [walletAddress, recipient.address],
        [-250n, 250n]
      );
    });

    it("reverts with ExecutionFailed when the call fails and keeps the transaction pending", async function () {
      const { wallet, owner1, owner2 } = await loadFixture(deployFixture);
      const reverter = await ethers.deployContract("Reverter");
      await submit(wallet, owner1, await reverter.getAddress(), ONE_ETH);
      await wallet.connect(owner1).confirmTransaction(0);
      await wallet.connect(owner2).confirmTransaction(0);

      const innerError = reverter.interface.encodeErrorResult("AlwaysFails", []);
      await expect(wallet.connect(owner1).executeTransaction(0))
        .to.be.revertedWithCustomError(wallet, "ExecutionFailed")
        .withArgs(0n, innerError);

      const [, , , executed] = await wallet.getTransaction(0);
      expect(executed).to.equal(false);
      expect(await ethers.provider.getBalance(await wallet.getAddress())).to.equal(
        ethers.parseEther("10")
      );
    });

    it("reverts with InsufficientBalance when the wallet cannot cover the value", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployFixture);
      const tooMuch = ethers.parseEther("11");
      await submit(wallet, owner1, recipient.address, tooMuch);
      await wallet.connect(owner1).confirmTransaction(0);
      await wallet.connect(owner2).confirmTransaction(0);
      await expect(wallet.connect(owner1).executeTransaction(0))
        .to.be.revertedWithCustomError(wallet, "InsufficientBalance")
        .withArgs(ethers.parseEther("10"), tooMuch);
    });

    it("can execute a previously underfunded transaction after a top-up", async function () {
      const { wallet, owner1, owner2, outsider, recipient } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("11");
      await submit(wallet, owner1, recipient.address, amount);
      await wallet.connect(owner1).confirmTransaction(0);
      await wallet.connect(owner2).confirmTransaction(0);
      await expect(wallet.connect(owner1).executeTransaction(0)).to.be.reverted;

      await outsider.sendTransaction({ to: await wallet.getAddress(), value: ONE_ETH });
      await expect(wallet.connect(owner1).executeTransaction(0)).to.changeEtherBalance(recipient, amount);
    });

    it("needs every owner in a 3-of-3 wallet", async function () {
      const [a, b, c, recipient] = await ethers.getSigners();
      const wallet = await ethers.deployContract("MultiSigWallet", [[a.address, b.address, c.address], 3]);
      await a.sendTransaction({ to: await wallet.getAddress(), value: ONE_ETH });
      await submit(wallet, a, recipient.address, ONE_ETH);
      await wallet.connect(a).confirmTransaction(0);
      await wallet.connect(b).confirmTransaction(0);

      await expect(wallet.connect(a).executeTransaction(0))
        .to.be.revertedWithCustomError(wallet, "NotEnoughConfirmations")
        .withArgs(0n, 2n, 3n);

      await wallet.connect(c).confirmTransaction(0);
      await expect(wallet.connect(a).executeTransaction(0)).to.changeEtherBalance(recipient, ONE_ETH);
    });

    it("keeps transactions independent of each other", async function () {
      const { wallet, owner1, owner2, recipient } = await loadFixture(deployFixture);
      await submit(wallet, owner1, recipient.address, 1n);
      await submit(wallet, owner1, recipient.address, 2n);
      await wallet.connect(owner1).confirmTransaction(1);
      await wallet.connect(owner2).confirmTransaction(1);

      expect(await wallet.getConfirmationCount(0)).to.equal(0n);
      expect(await wallet.isExecutable(0)).to.equal(false);
      expect(await wallet.isExecutable(1)).to.equal(true);
      expect(await wallet.isExecutable(99)).to.equal(false);
    });
  });

  // ------------------------------------------------------------------
  describe("Reentrancy protection", function () {
    async function attackerFixture() {
      const [a, b, recipient] = await ethers.getSigners();
      // 2-of-2 wallet; the malicious contract becomes a third owner
      // through the normal multi-sig flow.
      const wallet = await ethers.deployContract("MultiSigWallet", [[a.address, b.address], 2]);
      await a.sendTransaction({ to: await wallet.getAddress(), value: ethers.parseEther("10") });
      const attacker = await ethers.deployContract("ReentrancyAttacker", [await wallet.getAddress()]);
      const { exec } = await viaMultisig(wallet, [a, b], "addOwner", [await attacker.getAddress()]);
      await exec;
      return { wallet, attacker, a, b, recipient };
    }

    it("blocks re-entering executeTransaction for the same transaction", async function () {
      const { wallet, attacker, a, b } = await loadFixture(attackerFixture);
      const txId = await submit(wallet, a, await attacker.getAddress(), ONE_ETH);
      await wallet.connect(a).confirmTransaction(txId);
      await wallet.connect(b).confirmTransaction(txId);
      await attacker.setTarget(txId);

      await expect(wallet.connect(a).executeTransaction(txId)).to.changeEtherBalance(attacker, ONE_ETH);
      expect(await attacker.reentryAttempted()).to.equal(true);
      expect(await attacker.reentrySucceeded()).to.equal(false);
    });

    it("blocks re-entering to execute another confirmed transaction mid-call", async function () {
      const { wallet, attacker, a, b, recipient } = await loadFixture(attackerFixture);
      const payAttacker = await submit(wallet, a, await attacker.getAddress(), ONE_ETH);
      const payOther = await submit(wallet, a, recipient.address, ONE_ETH);
      for (const id of [payAttacker, payOther]) {
        await wallet.connect(a).confirmTransaction(id);
        await wallet.connect(b).confirmTransaction(id);
      }
      await attacker.setTarget(payOther);

      await wallet.connect(a).executeTransaction(payAttacker);
      expect(await attacker.reentrySucceeded()).to.equal(false);
      const [, , , otherExecuted] = await wallet.getTransaction(payOther);
      expect(otherExecuted).to.equal(false);
    });
  });

  // ------------------------------------------------------------------
  describe("Owner management (through the wallet itself)", function () {
    it("rejects direct calls from owners", async function () {
      const { wallet, owner1, newOwner } = await loadFixture(deployFixture);
      await expect(wallet.connect(owner1).addOwner(newOwner.address)).to.be.revertedWithCustomError(
        wallet,
        "OnlyWallet"
      );
      await expect(wallet.connect(owner1).removeOwner(owner1.address)).to.be.revertedWithCustomError(
        wallet,
        "OnlyWallet"
      );
      await expect(
        wallet.connect(owner1).replaceOwner(owner1.address, newOwner.address)
      ).to.be.revertedWithCustomError(wallet, "OnlyWallet");
      await expect(wallet.connect(owner1).changeRequirement(1)).to.be.revertedWithCustomError(
        wallet,
        "OnlyWallet"
      );
    });

    it("adds an owner after a confirmed multi-sig transaction", async function () {
      const { wallet, owner1, owner2, newOwner, recipient } = await loadFixture(deployFixture);
      const { exec } = await viaMultisig(wallet, [owner1, owner2], "addOwner", [newOwner.address]);
      await expect(exec).to.emit(wallet, "OwnerAdded").withArgs(newOwner.address);

      expect(await wallet.isOwner(newOwner.address)).to.equal(true);
      expect(await wallet.getOwners()).to.have.length(4);
      await expect(wallet.connect(newOwner).submitTransaction(recipient.address, 1n, "0x")).to.emit(
        wallet,
        "SubmitTransaction"
      );
    });

    it("refuses to add an existing owner", async function () {
      const { wallet, owner1, owner2, owner3 } = await loadFixture(deployFixture);
      const { txId, exec } = await viaMultisig(wallet, [owner1, owner2], "addOwner", [owner3.address]);
      const inner = wallet.interface.encodeErrorResult("DuplicateOwner", [owner3.address]);
      await expect(exec).to.be.revertedWithCustomError(wallet, "ExecutionFailed").withArgs(txId, inner);
    });

    it("removes an owner, who then loses all rights", async function () {
      const { wallet, owner1, owner2, owner3, recipient } = await loadFixture(deployFixture);
      const { exec } = await viaMultisig(wallet, [owner1, owner2], "removeOwner", [owner3.address]);
      await expect(exec).to.emit(wallet, "OwnerRemoved").withArgs(owner3.address);

      expect(await wallet.isOwner(owner3.address)).to.equal(false);
      expect(await wallet.getOwners()).to.deep.equal([owner1.address, owner2.address]);
      await expect(wallet.connect(owner3).submitTransaction(recipient.address, 1n, "0x"))
        .to.be.revertedWithCustomError(wallet, "NotOwner")
        .withArgs(owner3.address);
    });

    it("stops counting confirmations from a removed owner", async function () {
      const { wallet, owner1, owner2, owner3, recipient } = await loadFixture(deployFixture);
      // owner1 and owner3 approve a payment...
      const pay = await submit(wallet, owner1, recipient.address, ONE_ETH);
      await wallet.connect(owner1).confirmTransaction(pay);
      await wallet.connect(owner3).confirmTransaction(pay);
      expect(await wallet.getConfirmationCount(pay)).to.equal(2n);

      // ...then owner3 is removed before the payment is executed
      const { exec } = await viaMultisig(wallet, [owner1, owner2], "removeOwner", [owner3.address]);
      await exec;

      expect(await wallet.getConfirmationCount(pay)).to.equal(1n);
      await expect(wallet.connect(owner1).executeTransaction(pay))
        .to.be.revertedWithCustomError(wallet, "NotEnoughConfirmations")
        .withArgs(pay, 1n, 2n);
    });

    it("refuses to remove an owner if the threshold could no longer be met", async function () {
      const [a, b] = await ethers.getSigners();
      const wallet = await ethers.deployContract("MultiSigWallet", [[a.address, b.address], 2]);
      const { txId, exec } = await viaMultisig(wallet, [a, b], "removeOwner", [b.address]);
      const inner = wallet.interface.encodeErrorResult("InvalidRequirement", [1n, 2n]);
      await expect(exec).to.be.revertedWithCustomError(wallet, "ExecutionFailed").withArgs(txId, inner);
    });

    it("replaces an owner in one step", async function () {
      const { wallet, owner1, owner2, owner3, newOwner } = await loadFixture(deployFixture);
      const { exec } = await viaMultisig(wallet, [owner1, owner2], "replaceOwner", [
        owner3.address,
        newOwner.address,
      ]);
      await expect(exec)
        .to.emit(wallet, "OwnerRemoved")
        .withArgs(owner3.address)
        .and.to.emit(wallet, "OwnerAdded")
        .withArgs(newOwner.address);

      expect(await wallet.getOwners()).to.deep.equal([owner1.address, owner2.address, newOwner.address]);
      expect(await wallet.isOwner(owner3.address)).to.equal(false);
    });

    it("changes the threshold", async function () {
      const { wallet, owner1, owner2, owner3, recipient } = await loadFixture(deployFixture);
      const { exec } = await viaMultisig(wallet, [owner1, owner2], "changeRequirement", [3]);
      await expect(exec).to.emit(wallet, "RequirementChanged").withArgs(3n);
      expect(await wallet.required()).to.equal(3n);

      // Now two confirmations are no longer enough
      const pay = await submit(wallet, owner1, recipient.address, ONE_ETH);
      await wallet.connect(owner1).confirmTransaction(pay);
      await wallet.connect(owner2).confirmTransaction(pay);
      await expect(wallet.connect(owner1).executeTransaction(pay))
        .to.be.revertedWithCustomError(wallet, "NotEnoughConfirmations")
        .withArgs(pay, 2n, 3n);
      await wallet.connect(owner3).confirmTransaction(pay);
      await expect(wallet.connect(owner1).executeTransaction(pay)).to.changeEtherBalance(
        recipient,
        ONE_ETH
      );
    });

    it("refuses invalid owner addresses in add / remove / replace", async function () {
      const { wallet, owner1, owner2, owner3, outsider, newOwner } = await loadFixture(deployFixture);
      const walletAddress = await wallet.getAddress();
      const cases = [
        ["addOwner", [ethers.ZeroAddress], "InvalidOwner", [ethers.ZeroAddress]],
        ["addOwner", [walletAddress], "InvalidOwner", [walletAddress]],
        ["removeOwner", [outsider.address], "InvalidOwner", [outsider.address]],
        ["replaceOwner", [outsider.address, newOwner.address], "InvalidOwner", [outsider.address]],
        ["replaceOwner", [owner3.address, ethers.ZeroAddress], "InvalidOwner", [ethers.ZeroAddress]],
        ["replaceOwner", [owner3.address, walletAddress], "InvalidOwner", [walletAddress]],
        ["replaceOwner", [owner3.address, owner1.address], "DuplicateOwner", [owner1.address]],
      ];
      for (const [fn, args, error, errorArgs] of cases) {
        const { txId, exec } = await viaMultisig(wallet, [owner1, owner2], fn, args);
        const inner = wallet.interface.encodeErrorResult(error, errorArgs);
        await expect(exec).to.be.revertedWithCustomError(wallet, "ExecutionFailed").withArgs(txId, inner);
      }
      expect(await wallet.getOwners()).to.deep.equal([owner1.address, owner2.address, owner3.address]);
    });

    it("refuses to grow beyond MAX_OWNERS", async function () {
      const [a, b] = await ethers.getSigners();
      const others = Array.from({ length: 48 }, () => ethers.Wallet.createRandom().address);
      const wallet = await ethers.deployContract("MultiSigWallet", [[a.address, b.address, ...others], 2]);
      const extra = ethers.Wallet.createRandom().address;
      const { txId, exec } = await viaMultisig(wallet, [a, b], "addOwner", [extra]);
      const inner = wallet.interface.encodeErrorResult("InvalidRequirement", [51n, 2n]);
      await expect(exec).to.be.revertedWithCustomError(wallet, "ExecutionFailed").withArgs(txId, inner);
    });

    it("refuses an invalid threshold", async function () {
      const { wallet, owner1, owner2 } = await loadFixture(deployFixture);
      const { txId, exec } = await viaMultisig(wallet, [owner1, owner2], "changeRequirement", [4]);
      const inner = wallet.interface.encodeErrorResult("InvalidRequirement", [3n, 4n]);
      await expect(exec).to.be.revertedWithCustomError(wallet, "ExecutionFailed").withArgs(txId, inner);
    });
  });
});
