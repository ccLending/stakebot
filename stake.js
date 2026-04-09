require('dotenv').config();
const bs58 = require('bs58');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const {
  Keypair,
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const anchor = require('@coral-xyz/anchor');
const { getAssociatedTokenAddressSync, createTransferInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');

const idl = require("./idl/vela_anchor.json"); //测试网
//const idl = require("./idl/vela_anchor_main.json");  //主网

// 配置参数读取.env
const config = {
    mintAddress: process.env.MINT_ADDRESS || "",
    network: process.env.NETWORK || "LOCALNET",
    rpc: process.env.RPC || "http://47.109.157.92:8899",
    mnemonic: process.env.CHILD_WALLET_MNEMONIC,
    minAmount: Number(process.env.MIN_AMOUNT) || 20000,
    maxAmount: Number(process.env.MAX_AMOUNT) || 30000,
    startIndex: Number(process.env.START_INDEX) || 0,
    endIndex: Number(process.env.END_INDEX) || 100,
    referralAddress: process.env.REFERRAL_ADDRESS,
    solPerWallet: parseFloat(process.env.SOL_PER_WALLET) || 0.05,
};

const VELA_PROGRAM_ID = new PublicKey(idl.address);
const WALLET_ID_MAPPING_SEED = "wallet_id_mapping";
const USER_STAKE_SEED = "user_stake";
const GLOBAL_STATE_SEED = "global_state";
const LOCKED_TOKEN_VAULT_SEED = "locked_token_vault_seed";

function getReferralStoragePdas() {
    const storageAccounts = [];
    for (let i = 1; i <= 9; i++) {
        const [storagePda] = PublicKey.findProgramAddressSync(
            [Buffer.from('referral_storage'), Buffer.from([i])],
            VELA_PROGRAM_ID,
        );
        storageAccounts.push(storagePda);
    }
    return storageAccounts;
}

function getWalletMappingPda(walletPublicKey) {
    const [pda] = PublicKey.findProgramAddressSync(
        [WALLET_ID_MAPPING_SEED, walletPublicKey.toBuffer()], 
        VELA_PROGRAM_ID,
    );
    return pda;
}

function getVelaProgram(connection, wallet) {
    const provider = new anchor.AnchorProvider(
        connection, wallet, { commitment: connection.commitment || 'confirmed'}
    ); 
    return new anchor.Program(idl, provider);
}

async function generateChildWallets(mnemonic, fromIndex, endIndex) {
    if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error("无效的助记词");
    }
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const seedHex = seed.toString('hex');
    const wallets = [];
    console.log(`从 #${fromIndex} 到 #${endIndex} 开始生成子钱包...\n`);
    for (let i = fromIndex; i < endIndex; i++) {
        const path = `m/44'/501'/${i}'/0'`;
        const derivedSeed = derivePath(path, seedHex).key;
        const keypair = Keypair.fromSeed(derivedSeed);
        wallets.push({
            keypair,
            index: i,
        });
        console.log(`[子钱包 #${i}] 地址: ${keypair.publicKey.toBase58()}`);
    }
    console.log(`成功生成 ${wallets.length} 个钱包地址。#${fromIndex} - #${endIndex}`);
    return wallets;
}

let successCount = 0;
let failureCount = 0;
const failedIndices = [];

async function createStake(connection, wallet, walletIndex, tokenMint, amount, periodType) {
    const program = getVelaProgram(connection, new anchor.Wallet(wallet)); 
    const [userStakeAccount] = PublicKey.findProgramAddressSync([USER_STAKE_SEED, wallet.publicKey.toBuffer()], VELA_PROGRAM_ID);
    const [globalState] = PublicKey.findProgramAddressSync([GLOBAL_STATE_SEED], VELA_PROGRAM_ID);
    const walletMapping = getWalletMappingPda(wallet.publicKey);
    const storages = getReferralStoragePdas(connection);
    const [lockedVault] = PublicKey.findProgramAddressSync([LOCKED_TOKEN_VAULT_SEED, tokenMint.toBuffer()], VELA_PROGRAM_ID);
    const userTokenAccount = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey);
    const vaultTokenAccount = (await program.account.lockedTokenVault.fetch(lockedVault)).vaultTokenAccount;
      
    try {
        const tx = await program.methods
            .createStake(new anchor.BN(amount), periodType)
            .accounts({
                user: wallet.publicKey,
                userStakeAccount,
                globalState,
                userTokenAccount,
                lockedVault,
                vaultTokenAccount,
                walletMapping,
                storage1: storages[0],
                storage2: storages[1],
                storage3: storages[2],
                storage4: storages[3],
                storage5: storages[4],
                storage6: storages[5],
                storage7: storages[6],
                storage8: storages[7],
                storage9: storages[8],
                userState: null,
                nftBindingState: null,
                userNftAccount: null,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId
            })
            .rpc();
        console.log(`钱包 #${walletIndex} 质押 ${amount / 1e9} 代币 成功！ ${tx}`);
        successCount++;
    } catch (err) {
        console.error(`钱包 #${walletIndex} 质押失败: ${err}`);
        failureCount++;
        failedIndices.push(walletIndex);
    }
}

async function getTokenBalance(connection, walletPublicKey, tokenMint) {
    try {
        const ata = getAssociatedTokenAddressSync(tokenMint, walletPublicKey);
        const balance = await connection.getTokenAccountBalance(ata, 'confirmed');
        return balance.value.amount;
    } catch (err) {
        return 0;
    }
}

// 如果当前是格林威治时间0点到0点10分之间，无需等待直接运行。否则等到下一个0点运行
async function waitUntilMidnight() {
    const now = new Date();
    const start = new Date(now); 
    start.setUTCHours(0,0,0,0);     // 0点
    const end = new Date(now); 
    end.setUTCHours(0,10,0,0);      // 0点10分

    if (now >= start && now <= end) return;     //如果处在这个区间，无需等待
  
    const next = new Date(now);
    next.setUTCHours(0,0,0,0);
    if (now >= next) next.setUTCDate(next.getUTCDate() + 1);  // 下一个0点
    const delay = next - now;               // 计算间隔毫秒数
    await new Promise(r => setTimeout(r, delay));
}

async function sweepSubWallet(connection, subWallet, mainWalletPublicKey, tokenMint, tokenAmount, ataMainWallet) {
    const ataSubWallet = getAssociatedTokenAddressSync(tokenMint, subWallet.publicKey);
    const transaction = new Transaction().add(
        createTransferInstruction(
            ataSubWallet,
            ataMainWallet,
            subWallet.publicKey,
            tokenAmount
        )
    );
    await sendAndConfirmTransaction(connection, transaction, [subWallet]);

    const solBalance = await connection.getBalance(subWallet.publicKey);
    const feeReserve = 5000;
    if (solBalance <= feeReserve) return;
    const tx = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: subWallet.publicKey,
            toPubkey: mainWalletPublicKey,
            lamports: solBalance - feeReserve, 
        })
    );
    await sendAndConfirmTransaction(connection, tx, [subWallet]);
}

async function run() {
    const { default: PQueue } = await import('p-queue');
    const queue = new PQueue({ concurrency: 8 }); 
    const connection = new Connection(config.rpc, "confirmed");
    const privateKeyString = process.env.MAIN_WALLET_PRIVATE_KEY;
    if (!privateKeyString) {
        console.error("未找到环境变量 MAIN_WALLET_PRIVATE_KEY，请检查 .env 文件");
        process.exit(1);
    }
    const secretKey = bs58.decode(privateKeyString);
    const mainWallet = Keypair.fromSecretKey(secretKey);
    console.log(`✅ 成功加载主钱包: ${mainWallet.publicKey.toBase58()}`);
   
    const wallets = await generateChildWallets(config.mnemonic, config.startIndex, config.endIndex);
    
    console.log(`子钱包序号 #${config.startIndex} - #${config.endIndex} 质押前预处理，获取钱包代币余额用于质押额`)
    let walletPool = [];
    const tokenMint = new PublicKey(config.mintAddress);
    for (const wallet of wallets) {
        const amount = await getTokenBalance(connection, wallet.keypair.publicKey, tokenMint);
        walletPool.push({
            ...wallet,
            amount
        });
    }
    console.log("预处理就绪，等待零点起飞。。。")
    await waitUntilMidnight();

    console.log(`[启动]批量并发质押...`)
    for (const wallet of walletPool) {
        queue.add(() => createStake(connection, wallet.keypair, wallet.index, tokenMint, wallet.amount, 3));
        await new Promise(r => setTimeout(r, 50)); 
    }
    await queue.onIdle(); 
    console.log(`[完成]质押处理完成 成功: ${successCount}, 失败: ${failureCount}`);

    // 记录失败列表，用于后续再质押时排除。
    const subDir = path.join(__dirname, "checkpoints");
    const checkpoint_file = path.join(subDir, `stake-${config.startIndex}-${config.endIndex}.json`);
    fs.writeFileSync(checkpoint_file, JSON.stringify({ failedIndices }, null, 2));
    // 回收失败列表中的代币和SOL
    if (failureCount > 0) {
        console.log("开始回收失败列表中的代币和SOL...");
        console.log(failedIndices);
        const ataMainWallet = getAssociatedTokenAddressSync(tokenMint, mainWallet.publicKey);
        for (let i = 0; i < failedIndices.length; i++) {
            const subWallet = walletPool.find(w => w.index === failedIndices[i]);
            try {
                sweepSubWallet(connection, subWallet.keypair, mainWallet.publicKey, tokenMint, subWallet.amount, ataMainWallet);
                console.log(`子钱包 #${subWallet.index} 回收成功`);
            } catch (err) {
                console.error(`子钱包 #${subWallet.index} 回收失败`);
            }
        }
        console.log("回收完毕。");
    }
}

run();

