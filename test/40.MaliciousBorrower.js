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

describe('Attack Sapling Lending Pool', function () {
    const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';
    const TOKEN_DECIMALS = 6;

    let SaplingLendingPoolCF;
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

        SaplingLendingPoolCF = await ethers.getContractFactory('SaplingLendingPool');
        let LoanDeskCF = await ethers.getContractFactory('LoanDesk');

        liquidityToken = await (
            await ethers.getContractFactory('PoolToken')
        ).deploy('Test USDC', 'TestUSDC', TOKEN_DECIMALS);

        poolToken = await (
            await ethers.getContractFactory('PoolToken')
        ).deploy('Sapling Test Lending Pool Token', 'SLPT', TOKEN_DECIMALS);

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
    });

    describe('Deployment', function () {
        it('Can deploy', async function () {
            await expect(
                upgrades.deployProxy(SaplingLendingPoolCF, [
                    poolToken.address,
                    liquidityToken.address,
                    deployer.address,
                    protocol.address,
                    manager.address,
                ]),
            ).to.be.not.reverted;
        });

        describe('Rejection Scenarios', function () {});
    });

    describe('Use Cases', function () {
        const LoanStatus = {
            NULL: 0,
            OUTSTANDING: 1,
            REPAID: 2,
            DEFAULTED: 3,
        };

        let PERCENT_DECIMALS;
        let TOKEN_MULTIPLIER;
        let ONE_HUNDRED_PERCENT;
        let exitFeePercent;

        let lender1;
        let lender2;
        let lender3;
        let borrower1;
        let borrower2;

        let stakeAmount;
        let unstakeAmount;
        let depositAmount;
        let withdrawAmount;
        let loanAmount;
        let loanDuration;

        before(async function () {
            PERCENT_DECIMALS = await lendingPool.percentDecimals();
            TOKEN_MULTIPLIER = BigNumber.from(10).pow(TOKEN_DECIMALS);
            ONE_HUNDRED_PERCENT = await lendingPool.oneHundredPercent();
            exitFeePercent = await lendingPool.exitFeePercent();

            lender1 = addresses[1];
            lender2 = addresses[2];
            lender3 = addresses[3];

            borrower1 = addresses[4];
            borrower2 = addresses[5];

            stakeAmount = BigNumber.from(2000).mul(TOKEN_MULTIPLIER);
            unstakeAmount = BigNumber.from(500).mul(TOKEN_MULTIPLIER);
            depositAmount = BigNumber.from(9000).mul(TOKEN_MULTIPLIER);
            withdrawAmount = BigNumber.from(3000).mul(TOKEN_MULTIPLIER);
            loanAmount = BigNumber.from(1000).mul(TOKEN_MULTIPLIER);
            loanDuration = BigNumber.from(365).mul(24 * 60 * 60);

            await liquidityToken.connect(deployer).mint(manager.address, stakeAmount);
            await liquidityToken.connect(manager).approve(lendingPool.address, stakeAmount);
            await lendingPool.connect(manager).stake(stakeAmount);

            await liquidityToken.connect(deployer).mint(lender1.address, depositAmount);
            await liquidityToken.connect(lender1).approve(lendingPool.address, depositAmount);
            await lendingPool.connect(lender1).deposit(depositAmount);
            let initialBalance = BigNumber.from(1e12).mul(TOKEN_MULTIPLIER);
            await liquidityToken.connect(deployer).mint(borrower1.address, initialBalance);
        });

        describe('Malicious Borrower', function () {
            let applicationId;

            after(async function () {
                await rollback();
            });

            before(async function () {
                await snapshot();

                gracePeriod = await loanDesk.templateLoanGracePeriod();
                installments = 1;
                apr = await loanDesk.templateLoanAPR();

                let loanAmount = BigNumber.from(1000).mul(TOKEN_MULTIPLIER);
                let loanDuration = BigNumber.from(365).mul(24 * 60 * 60);
                await loanDesk
                    .connect(borrower1)
                    .requestLoan(
                        loanAmount,
                        loanDuration,
                        'a937074e-85a7-42a9-b858-9795d9471759',
                        '6ed20e4f9a1c7827f58bf833d47a074cdbfa8773f21c1081186faba1569ddb29',
                    );
                applicationId = (await loanDesk.borrowerStats(borrower1.address)).recentApplicationId;
                application = await loanDesk.loanApplications(applicationId);
                await loanDesk
                    .connect(manager)
                    .offerLoan(
                        applicationId,
                        application.amount,
                        application.duration,
                        gracePeriod,
                        0,
                        installments,
                        apr,
                    );
            });

            it('Revert If Borrow Twice Same Block', async function () {
                //get initial loans count to check only 1 loan object was created
                let prevLoansCount = await lendingPool.loansCount();

                let balanceBefore = await liquidityToken.balanceOf(borrower1.address);
                //turn of automining before write tx to keep the block open for the next call
                await ethers.provider.send("evm_setAutomine", [false]);
                await lendingPool.connect(borrower1).borrow(applicationId);
                
                //tun automining back on to prevent deadlock as expect() will hang until block is finalized
                await ethers.provider.send("evm_setAutomine", [true]);
                await expect(lendingPool.connect(borrower1).borrow(applicationId)).to.be.reverted;

                // check that only 1 new loan object was created
                expect(await lendingPool.loansCount()).to.equal(prevLoansCount.add(1));

                //get the loan after the block is mined, as the committed block 
                let loanId = (await lendingPool.borrowerStats(borrower1.address)).recentLoanId;
                let loan = await lendingPool.loans(loanId);

                expect(await liquidityToken.balanceOf(borrower1.address)).to.equal(balanceBefore.add(loan.amount));
            });

            it('Revert If Borrow Twice Slow', async function () {
                let balanceBefore = await liquidityToken.balanceOf(borrower1.address);
                await lendingPool.connect(borrower1).borrow(applicationId);
                let loanId = (await lendingPool.borrowerStats(borrower1.address)).recentLoanId;
                let loan = await lendingPool.loans(loanId);
                await ethers.provider.send('evm_increaseTime', [loan.duration.toNumber()]);
                await ethers.provider.send('evm_mine');
                await expect(lendingPool.connect(borrower1).borrow(applicationId)).to.be.reverted;
                expect(await liquidityToken.balanceOf(borrower1.address)).to.equal(balanceBefore.add(loan.amount));
            });

            it('Revert If Borrow Repay Borrow', async function () {
                await lendingPool.connect(borrower1).borrow(applicationId);
                let loanId = (await lendingPool.borrowerStats(borrower1.address)).recentLoanId;
                let loan = await lendingPool.loans(loanId);
                let paymentAmount = (await lendingPool.loanBalanceDue(loanId));
                await liquidityToken.connect(borrower1).approve(lendingPool.address, paymentAmount);
                await lendingPool.connect(borrower1).repay(loanId, paymentAmount);
                await expect(lendingPool.connect(borrower1).borrow(applicationId)).to.be.reverted;
            });

            it('Revert If Borrow Repay Half Borrow', async function () {
                await lendingPool.connect(borrower1).borrow(applicationId);
                let loanId = (await lendingPool.borrowerStats(borrower1.address)).recentLoanId;
                let loan = await lendingPool.loans(loanId);
                let paymentAmount = (await lendingPool.loanBalanceDue(loanId)).div(2);
                await liquidityToken.connect(borrower1).approve(lendingPool.address, paymentAmount);
                await lendingPool.connect(borrower1).repay(loanId, paymentAmount);
                await expect(lendingPool.connect(borrower1).borrow(applicationId)).to.be.reverted;
            });

            it('Revert If Request Loan Twice', async function () {
                gracePeriod = await loanDesk.templateLoanGracePeriod();
                installments = 1;
                apr = await loanDesk.templateLoanAPR();
                let loanAmount = BigNumber.from(1000).mul(TOKEN_MULTIPLIER);
                let loanDuration = BigNumber.from(365).mul(24 * 60 * 60);
                await expect(loanDesk
                    .connect(borrower1)
                    .requestLoan(
                        loanAmount,
                        loanDuration,
                        'a937074e-85a7-42a9-b858-9795d9471759',
                        '6ed20e4f9a1c7827f58bf833d47a074cdbfa8773f21c1081186faba1569ddb29',
                    )).to.be.reverted;
            });

            it('Revert On Tiny Repayment', async function () {
                await lendingPool.connect(borrower1).borrow(applicationId);
                let loanId = (await lendingPool.borrowerStats(borrower1.address)).recentLoanId;
                const tinyAmount = 1;
                await liquidityToken.connect(borrower1).approve(lendingPool.address, tinyAmount);
                await expect(lendingPool.connect(borrower1).repay(loanId, tinyAmount)).to.be.reverted;
            });

            it('Check Repayment Math', async function () {
                const quickFuzz = [10,20,30,40,50,60,70,80,90,100,249];
                await lendingPool.connect(borrower1).borrow(applicationId);
                let loanAmount = BigNumber.from(1000).mul(TOKEN_MULTIPLIER);
                let loanId = (await lendingPool.borrowerStats(borrower1.address)).recentLoanId;
                for (let i = 0; i < quickFuzz.length; i++) {
                    const multiAmount = BigNumber.from(quickFuzz[i]).mul(TOKEN_MULTIPLIER);
                    await liquidityToken.connect(borrower1).approve(lendingPool.address, multiAmount);
                    await lendingPool.connect(borrower1).repay(loanId, multiAmount);
                    let paymentAmount = await lendingPool.loanBalanceDue(loanId);
                    loanAmount = loanAmount.sub(multiAmount);
                    expect(paymentAmount).to.equal(loanAmount);
                }
            });
        });
    });
});
