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
const { getAssociatedTokenAddressSync, createTransferInstruction, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');

const idl = require("./idl/vela_anchor.json"); //测试网
//const idl = require("./idl/vela_anchor_main.json");  //主网

// 配置参数读取.env
const config = {
    mintAddress: process.env.MINT_ADDRESS || "",
    network: process.env.NETWORK || "LOCALNET",
    rpc: process.env.RPC || "http://47.109.157.92:8899",
    minAmount: Number(process.env.MIN_AMOUNT) || 20000,
    maxAmount: Number(process.env.MAX_AMOUNT) || 30000,
    startIndex: Number(process.env.START_INDEX) || 0,
    endIndex: Number(process.env.END_INDEX) || 100,
    referralAddress: process.env.REFERRAL_ADDRESS,
    solPerWallet: parseFloat(process.env.SOL_PER_WALLET) || 0.05,
};

const VELA_PROGRAM_ID = new PublicKey(idl.address);
const WALLET_ID_MAPPING_SEED = "wallet_id_mapping";
const REFERRAL_MANAGER_SEED = "referral_manager";
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

async function getWalletId(program, walletPublicKey) {
    const pda = getWalletMappingPda(walletPublicKey);
    return (await program.account.walletIdMapping.fetch(pda)).referralId;
}

async function addReferral(connection, wallet, walletIndex) {
    const program = getVelaProgram(connection, new anchor.Wallet(wallet)); 
    const walletMappingPda = getWalletMappingPda(wallet.publicKey);
    const storages = getReferralStoragePdas(connection);  
    const [manager] = PublicKey.findProgramAddressSync([REFERRAL_MANAGER_SEED], VELA_PROGRAM_ID);
    const [globalStatePda] = PublicKey.findProgramAddressSync([GLOBAL_STATE_SEED], VELA_PROGRAM_ID);
    const referralFeeWallet = (await program.account.globalState.fetch(globalStatePda)).referralFeeWallet;
    const parentId = await getWalletId(program, new PublicKey(config.referralAddress));
    
    try {
        const tx = await program.methods
            .addReferral(
                wallet.publicKey,
                parentId
            )
            .accounts({
                payer: wallet.publicKey,
                walletSigner: wallet.publicKey,
                manager,
                storage1: storages[0],
                storage2: storages[1],
                storage3: storages[2],
                storage4: storages[3],
                storage5: storages[4],
                storage6: storages[5],
                storage7: storages[6],
                storage8: storages[7],
                storage9: storages[8],
                walletMapping: walletMappingPda,
                globalState: globalStatePda,
                referralFeeWallet,
                systemProgram: SystemProgram.programId,
            })
            .rpc(); 
        console.log(`钱包 #${walletIndex} 绑定推荐人成功！ ${tx}`);
    } catch (err) {
        console.error(`钱包 #${walletIndex} 绑定推荐人失败: 推荐人已存在。`);
    }
}

//const mnemonic = bip39.generateMnemonic(); 
//console.log("生成的助记词:", mnemonic);

function saveCheckpoint(filePath, newIndex) {
    const existingData = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath)) : {};
    const updatedData = {
        ...existingData,
        currentIndex: newIndex
    };
    fs.writeFileSync(filePath, JSON.stringify(updatedData, null, 2));
}

async function generateChildWallets(mnemonic, index) {
    if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error("无效的助记词");
    }
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const seedHex = seed.toString('hex');
    const path = `m/44'/501'/${index}'/0'`;
    const derivedSeed = derivePath(path, seedHex).key;
    const keypair = Keypair.fromSeed(derivedSeed);
    console.log(`生成子钱包 #${index} 地址: ${keypair.publicKey.toBase58()}`);
    return keypair;
}

async function transferToken(connection, mainWallet, subWallet, subWalletIndex, tokenMint) {
    const sourceATA = getAssociatedTokenAddressSync(tokenMint, mainWallet.publicKey);
    try {
        const minAmount = Math.ceil(config.minAmount / 1000);
        const maxAmount = Math.floor(config.maxAmount / 1000);
        const randomAmount = (Math.floor(Math.random() * (maxAmount - minAmount + 1)) + minAmount) * 1000;

        const transaction = new Transaction();
        const destATA = getAssociatedTokenAddressSync(tokenMint, subWallet.publicKey);
        const destAccountInfo = await connection.getAccountInfo(destATA);
        if (!destAccountInfo) {
            transaction.add(
                createAssociatedTokenAccountInstruction(
                    mainWallet.publicKey,
                    destATA,
                    subWallet.publicKey,
                    tokenMint
                )
            );
        }
        transaction.add(
            createTransferInstruction(
                sourceATA,
                destATA,
                mainWallet.publicKey,
                randomAmount * 1e9
            )
        );
        await sendAndConfirmTransaction(connection, transaction, [mainWallet]);
        console.log(`向子钱包 #${subWalletIndex} 转账 ${randomAmount} tokens 成功`);
        return randomAmount * 1e9;

    } catch (err) {
        console.error(`❌ 子钱包 #${subWalletIndex} 转账失败`);
        return 0;
    }
}

async function run() {
    const connection = new Connection(config.rpc, "confirmed");
    const privateKeyString = process.env.MAIN_WALLET_PRIVATE_KEY;
    const mnemonic = process.env.CHILD_WALLET_MNEMONIC;
    if (!privateKeyString) {
        console.error("未找到环境变量 MAIN_WALLET_PRIVATE_KEY，请检查 .env 文件");
        process.exit(1);
    }
    const secretKey = bs58.decode(privateKeyString);
    const mainWallet = Keypair.fromSecretKey(secretKey);
    console.log(`✅ 成功加载主钱包: ${mainWallet.publicKey.toBase58()}`);
   
    console.log(`[启动] 准备为子钱包 #${config.startIndex} - #${config.endIndex - 1} 充值并绑定推荐人`);
    let currentIndex = config.startIndex;
    const subDir = path.join(__dirname, "checkpoints");
    if (!fs.existsSync(subDir)) fs.mkdirSync(subDir);
    const checkpoint_file = path.join(subDir, `prepare-${config.startIndex}-${config.endIndex}.json`);
    if (fs.existsSync(checkpoint_file)) { 
        currentIndex = JSON.parse(fs.readFileSync(checkpoint_file)).currentIndex;
        console.log(`当前断点序号: ${currentIndex}，从此处继续...`);
    }
    for (let index = currentIndex; index < config.endIndex; index++) {
        const wallet = await generateChildWallets(mnemonic, index);

        const transaction = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: mainWallet.publicKey,
                toPubkey: wallet.publicKey,
                lamports: config.solPerWallet * LAMPORTS_PER_SOL,
            })
        );
        try {
            await sendAndConfirmTransaction(connection, transaction, [mainWallet]);
        } catch (err) {
            console.error("请检查主钱包SOL余额，充值后继续");
            process.exit(0);
        }

        const tokenAmount = await transferToken(connection, mainWallet, wallet, index, new PublicKey(config.mintAddress));
        if (tokenAmount === 0) {
            console.error("请检查主钱包代币余额，充值后重新启动");
            process.exit(0);
        }

        await addReferral(connection, wallet, index);
        saveCheckpoint(checkpoint_file, index + 1);
    }
    console.log(`[完成] 准备阶段处理完毕，子钱包 #${config.startIndex} - #${config.endIndex - 1} 已充值并绑定推荐人`);
}

run();

