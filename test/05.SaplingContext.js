const { expect } = require('chai');
const { BigNumber } = require('ethers');
const { ethers, upgrades } = require('hardhat');
const { assertHardhatInvariant } = require('hardhat/internal/core/errors');

let evmSnapshotIds = [];

async function snapshot() {
    let id = await hre.network.provider.send('evm_snapshot');
    evmSnapshotIds.push(id);
}

async function rollback() {
    let id = evmSnapshotIds.pop();
    await hre.network.provider.send('evm_revert', [id]);
}

describe('Sapling Context (via SaplingLendingPool)', function () {
    const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';
    const TOKEN_DECIMALS = 6;

    let SaplingContextCF;
    let saplingContext;
    let liquidityToken;
    let poolToken;
    let loanDesk;

    let deployer;
    let governance;
    let protocol;
    let manager;
    let addresses;

    beforeEach(async function () {
        await snapshot();
    });

    afterEach(async function () {
        await rollback();
    });

    before(async function () {
        [deployer, governance, protocol, manager, ...addresses] = await ethers.getSigners();

        let SaplingLendingPoolCF = await ethers.getContractFactory('SaplingLendingPool');
        let PoolTokenCF = await ethers.getContractFactory('PoolToken');
        let LoanDeskCF = await ethers.getContractFactory('LoanDesk');

        liquidityToken = await PoolTokenCF.deploy('Test USDC', 'TestUSDC', TOKEN_DECIMALS);

        poolToken = await PoolTokenCF.deploy('Sapling Test Lending Pool Token', 'SLPT', TOKEN_DECIMALS);

        lendingPool = await upgrades.deployProxy(SaplingLendingPoolCF, [
            poolToken.address,
            liquidityToken.address,
            deployer.address,
            protocol.address,
            manager.address,
        ]);
        await lendingPool.deployed();

        loanDesk = await upgrades.deployProxy(LoanDeskCF, [
            lendingPool.address,
            governance.address,
            protocol.address,
            manager.address,
            TOKEN_DECIMALS,
        ]);
        await loanDesk.deployed();

        await poolToken.connect(deployer).transferOwnership(lendingPool.address);
        await lendingPool.connect(deployer).setLoanDesk(loanDesk.address);
        await lendingPool.connect(deployer).transferGovernance(governance.address);

        SaplingContextCF = SaplingLendingPoolCF;
        saplingContext = lendingPool;
    });

    describe('Deployment', function () {
        it('Can deploy', async function () {

            await expect(
                upgrades.deployProxy(SaplingContextCF, [
                    poolToken.address,
                    liquidityToken.address,
                    deployer.address,
                    protocol.address,
                    manager.address,
                ]),
            ).to.be.not.reverted;
        });

        describe('Rejection Scenarios', function () {
            it('Deploying with null governance address should fail', async function () {
                await expect(
                    upgrades.deployProxy(SaplingContextCF, [
                        poolToken.address,
                        liquidityToken.address,
                        NULL_ADDRESS,
                        protocol.address,
                        manager.address,
                    ]),
                ).to.be.reverted;
            });

            it('Deploying with null protocol wallet address should fail', async function () {
                await expect(
                    upgrades.deployProxy(SaplingContextCF, [
                        poolToken.address,
                        liquidityToken.address,
                        governance.address,
                        NULL_ADDRESS,
                        manager.address,
                    ]),
                ).to.be.reverted;
            });
        });
    });

    describe('Use Cases', function () {
        describe('Initial State', function () {
            it('Governance address is correct', async function () {
                expect(await saplingContext.governance()).to.equal(governance.address);
            });

            it('Protocol wallet address is correct', async function () {
                expect(await saplingContext.treasury()).to.equal(protocol.address);
            });

            it('Context is not paused', async function () {
                expect(await saplingContext.paused()).to.equal(false);
            });
        });

        describe('Transfer Governance', function () {
            let governance2;

            after(async function () {
                await rollback();
            });

            before(async function () {
                await snapshot();

                governance2 = addresses[0];
                assertHardhatInvariant(governance.address != governance2.address);
            });

            it('Can transfer', async function () {
                await saplingContext.connect(governance).transferGovernance(governance2.address);
                expect(await saplingContext.governance())
                    .to.equal(governance2.address)
                    .and.not.equal(governance);
            });

            describe('Rejection scenarios', function () {
                it('Transferring to NULL address should fail', async function () {
                    await expect(saplingContext.connect(governance).transferGovernance(NULL_ADDRESS)).to.be.reverted;
                });

                it('Transferring governance to same address should fail', async function () {
                    await expect(saplingContext.connect(governance).transferGovernance(governance.address)).to.be
                        .reverted;
                });

                it('Transferring governance to treasury address should fail', async function () {
                    await expect(
                        saplingContext.connect(governance).transferGovernance(protocol.address),
                    ).to.be.revertedWith('SaplingContext: invalid governance address');
                });

                it('Transferring governance to pool manager address should fail', async function () {
                    await expect(
                        saplingContext.connect(governance).transferGovernance(manager.address),
                    ).to.be.revertedWith('SaplingContext: invalid governance address');
                });

                it('Transfer as non governance should fail', async function () {
                    await expect(saplingContext.connect(addresses[1]).transferGovernance(governance2.address)).to.be
                        .reverted;
                });
            });
        });

        describe('Transfer Treasury Wallet', function () {
            let protocol2;

            after(async function () {
                await rollback();
            });

            before(async function () {
                await snapshot();

                protocol2 = addresses[0];
                assertHardhatInvariant(protocol.address != protocol2.address);
            });

            it('Can transfer', async function () {
                await saplingContext.connect(governance).transferTreasury(protocol2.address);
                expect(await saplingContext.treasury())
                    .to.equal(protocol2.address)
                    .and.not.equal(protocol.address);
            });

            describe('Rejection scenarios', function () {
                it('Transfer as non governance should fail', async function () {
                    await expect(saplingContext.connect(addresses[1]).transferTreasury(protocol2.address)).to.be
                        .reverted;
                });

                it('Transferring to governance address should fail', async function () {
                    await expect(
                        saplingContext.connect(governance).transferTreasury(governance.address),
                    ).to.be.revertedWith('SaplingContext: invalid treasury wallet address');
                });

                it('Transferring to pool manager address should fail', async function () {
                    await expect(
                        saplingContext.connect(governance).transferTreasury(manager.address),
                    ).to.be.revertedWith('SaplingContext: invalid treasury wallet address');
                });

                it('Transferring to a NULL address should fail', async function () {
                    await expect(saplingContext.connect(governance).transferTreasury(NULL_ADDRESS)).to.be.reverted;
                });
            });
        });

        describe('Pause', function () {
            it('Governance can pause', async function () {
                await saplingContext.connect(governance).pause();
                expect(await saplingContext.paused()).to.equal(true);
            });

            describe('Rejection scenarios', function () {
                it('Pausing when paused should fail', async function () {
                    await saplingContext.connect(governance).pause();
                    await expect(saplingContext.connect(governance).pause()).to.be.reverted;
                });

                it('Pausing as a non governance should fail', async function () {
                    await expect(saplingContext.connect(addresses[0]).pause()).to.be.reverted;
                });
            });
        });

        describe('Resume', function () {
            beforeEach(async function () {
                await saplingContext.connect(governance).pause();
            });

            it('Governance can resume', async function () {
                await saplingContext.connect(governance).unpause();
                expect(await saplingContext.paused()).to.equal(false);
            });

            describe('Rejection scenarios', function () {
                it('Resuming when not paused should fail', async function () {
                    await saplingContext.connect(governance).unpause();
                    await expect(saplingContext.connect(governance).unpause()).to.be.reverted;
                });

                it('Resuming as a non governance should fail', async function () {
                    await expect(saplingContext.connect(addresses[0]).unpause()).to.be.reverted;
                });
            });
        });
    });
});
