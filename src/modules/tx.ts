import {Client} from '../client';
import * as is from 'is_js';
import * as types from '../types';
import { SdkError, CODES } from '../errors';
import {Utils, Crypto} from '../utils';

/**
 * Tx module allows you to sign or broadcast transactions
 *
 * @category Modules
 * @since v0.17
 */
export class Tx {
  /** @hidden */
  private client: Client;

  /** @hidden */
  constructor(client: Client) {
    this.client = client;
  }

  /**
   * Build Tx
   * @param msgs Msgs to be sent
   * @param baseTx
   * @returns unsignedTx
   * @since v0.17
   */
  buildTx(
    msgs: any[],
    baseTx: types.BaseTx,
  ): types.ProtoTx {
    let msgList: types.Msg[] = msgs.map(msg => {
      return this.createMsg(msg);
    });
    const unsignedTx: types.ProtoTx = this.client.auth.newStdTx(msgList, baseTx);
    return unsignedTx;
  }

  /**
   * generate StdTx from protoTxModel
   * @param  {[type]} protoTxModel:any instance of cosmos.tx.v1beta1.Tx 
   * @return {[type]} unsignedTx
   */
  newStdTxFromProtoTxModel(protoTxModel:any):types.ProtoTx{
    return  types.ProtoTx.newStdTxFromProtoTxModel(protoTxModel);
  }

  /**
   * generate StdTx from Tx Data
   * @param  {[type]} TxData:string  base64 string form txBytes
   * @return {[type]} unsignedTx
   */
  newStdTxFromTxData(TxDataString:string):types.ProtoTx{
    const protoTxModel = this.client.protobuf.deserializeTx(TxDataString, true)
    return  types.ProtoTx.newStdTxFromProtoTxModel(protoTxModel);
  }

  /**
   * Build, sign and broadcast the msgs
   * @param msgs Msgs to be sent
   * @param baseTx
   * @returns
   * @since v0.17
   */
  async buildAndSend(
    msgs: any[],
    baseTx: types.BaseTx
  ) {
    // Build Unsigned Tx
    const unsignedTx: types.ProtoTx = this.buildTx(msgs, baseTx);

    // Sign Tx
    const signedTx = await this.sign(unsignedTx, baseTx);
    // Broadcast Tx
    return this.broadcast(signedTx, baseTx.mode);
  }

  /**
   * Broadcast a tx
   * @param signedTx The tx object with signatures
   * @param mode Broadcast mode
   * @returns
   * @since v0.17
   */
  broadcast(
    signedTx: types.ProtoTx,
    mode?: types.BroadcastMode
  ): Promise<types.TxResult> {
    const txBytes = signedTx.getData();

    switch (mode) {
      case types.BroadcastMode.Commit:
        return this.broadcastTxCommit(txBytes);
      case types.BroadcastMode.Sync:
        return this.broadcastTxSync(txBytes).then(response => {
          return this.newTxResult(response.hash);
        });
      default:
        return this.broadcastTxAsync(txBytes).then(response => {
          return this.newTxResult(response.hash);
        });
    }
  }

  /**
   * Single sign a transaction
   *
   * @param stdTx StdTx with no signatures
   * @param baseTx baseTx.from && baseTx.password is requred
   * @returns The signed tx
   * @since v0.17
   */
  async sign(
    stdTx: types.ProtoTx,
    baseTx: types.BaseTx,
  ): Promise<types.ProtoTx> {
    if (is.empty(baseTx.from)) {
      throw new SdkError(`baseTx.from of the key can not be empty`);
    }
    if (is.empty(baseTx.password)) {
      throw new SdkError(`baseTx.password of the key can not be empty`);
    }
    if (!this.client.config.keyDAO.decrypt) {
      throw new SdkError(`Decrypt method of KeyDAO not implemented`,CODES.Panic);
    }

    const keyObj = this.client.config.keyDAO.read(baseTx.from);
    if (!keyObj) {
      throw new SdkError(`Key with name '${baseTx.from}' not found`,CODES.KeyNotFound);
    }

    let accountNumber = baseTx.account_number??'0';
    let sequence = baseTx.sequence || '0';

    if (!baseTx.account_number || !baseTx.sequence) {
      const account = await this.client.auth.queryAccount(keyObj.address);
      if ( account.accountNumber ) { accountNumber = String(account.accountNumber) || '0' }
      if ( account.sequence ) { sequence = String(account.sequence) || '0' }
    }
    // Query account info from block chain
    const privKey = this.client.config.keyDAO.decrypt(keyObj.privateKey, baseTx.password);
    if (!privKey) {
      throw new SdkError(`decrypto the private key error`,CODES.InvalidPassword);
    }
    if (!stdTx.hasPubKey()) {
      const pubKey = Crypto.getPublicKeyFromPrivateKey(privKey, baseTx.pubkeyType);
      stdTx.setPubKey(pubKey, sequence || undefined);
    }
    const signature = Crypto.generateSignature(stdTx.getSignDoc(accountNumber || undefined, this.client.config.chainId).serializeBinary(), privKey, baseTx.pubkeyType);
    stdTx.addSignature(signature);
    return stdTx;
  }

  /**
   * Single sign a transaction with signDoc
   *
   * @param signDoc from protobuf
   * @param name Name of the key to sign the tx
   * @param password Password of the key
   * @param type pubkey Type
   * @returns signature
   * @since v0.17
   */
  sign_signDoc(
    signDoc: Uint8Array,
    name: string,
    password: string,
    type:types.PubkeyType = types.PubkeyType.secp256k1
  ): string {
    if (is.empty(name)) {
      throw new SdkError(`Name of the key can not be empty`);
    }
    if (is.empty(password)) {
      throw new SdkError(`Password of the key can not be empty`);
    }
    if (!this.client.config.keyDAO.decrypt) {
      throw new SdkError(`Decrypt method of KeyDAO not implemented`);
    }

    const keyObj = this.client.config.keyDAO.read(name);
    if (!keyObj) {
      throw new SdkError(`Key with name '${name}' not found`,CODES.KeyNotFound);
    }

    const privKey = this.client.config.keyDAO.decrypt(keyObj.privateKey, password);
    const signature = Crypto.generateSignature(signDoc, privKey, type);
    return signature;
  }

  /**
   * Broadcast tx async
   * @param txBytes The tx bytes with signatures
   * @returns
   */
  private broadcastTxAsync(
    txBytes: Uint8Array
  ): Promise<types.ResultBroadcastTxAsync> {
    return this.broadcastTx(txBytes, types.RpcMethods.BroadcastTxAsync);
  }

  /**
   * Broadcast tx sync
   * @param txBytes The tx bytes with signatures
   * @returns The result object of broadcasting
   */
  private broadcastTxSync(
    txBytes: Uint8Array
  ): Promise<types.ResultBroadcastTxAsync> {
    return this.broadcastTx(txBytes, types.RpcMethods.BroadcastTxSync);
  }

  /**
   * Broadcast tx and wait for it to be included in a block.
   * @param txBytes The tx bytes with signatures
   * @returns The result object of broadcasting
   */
  private broadcastTxCommit(txBytes: Uint8Array): Promise<types.TxResult> {
    return this.client.rpcClient
      .request<types.ResultBroadcastTx>(types.RpcMethods.BroadcastTxCommit, {
        tx: Utils.bytesToBase64(txBytes),
      })
      .then(response => {
        // Check tx error
        if (response.check_tx && response.check_tx.code > 0) {
          console.error(response.check_tx);
          throw new SdkError(response.check_tx.log, response.check_tx.code);
        }

        // Deliver tx error
        if (response.deliver_tx && response.deliver_tx.code > 0) {
          console.error(response.deliver_tx);
          throw new SdkError(response.deliver_tx.log, response.deliver_tx.code);
        }

        if (response.deliver_tx && response.deliver_tx.tags) {
          response.deliver_tx.tags = Utils.decodeTags(response.deliver_tx.tags);
        }
        return {
          hash: response.hash,
          height: response.height,
          gas_wanted: response.deliver_tx?.gas_wanted,
          gas_used: response.deliver_tx?.gas_used,
          info: response.deliver_tx?.info,
          tags: response.deliver_tx?.tags,
        };
      });
  }

  /**
   * Broadcast tx sync or async
   * @private
   * @param signedTx The tx object with signatures
   * @returns The result object of broadcasting
   */
  private broadcastTx(
    txBytes: Uint8Array,
    method: string
  ): Promise<types.ResultBroadcastTxAsync> {
    // Only accepts 'broadcast_tx_sync' and 'broadcast_tx_async'
    if (
      is.not.inArray(method, [
        types.RpcMethods.BroadcastTxSync,
        types.RpcMethods.BroadcastTxAsync,
      ])
    ) {
      throw new SdkError(`Unsupported broadcast method: ${method}`,CODES.Internal);
    }

    return this.client.rpcClient
      .request<types.ResultBroadcastTxAsync>(method, {
        tx: Utils.bytesToBase64(txBytes),
      })
      .then(response => {
        if (response.code && response.code > 0) {
          throw new SdkError(response.log, response.code);
        }

        return response;
      });
  }

  // private marshal(stdTx: types.Tx<types.StdTx>): types.Tx<types.StdTx> {
  //   const copyStdTx: types.Tx<types.StdTx> = stdTx;
  //   Object.assign(copyStdTx, stdTx);
  //   stdTx.value.msg.forEach((msg, idx) => {
  //     if (msg.marshal) {
  //       copyStdTx.value.msg[idx] = msg.marshal();
  //     }
  //   });
  //   return copyStdTx;
  // }

  private newTxResult(
    hash: string,
    height?: number,
    deliverTx?: types.ResultTx
  ): types.TxResult {
    return {
      hash,
      height,
      gas_wanted: deliverTx?.gas_wanted,
      gas_used: deliverTx?.gas_used,
      info: deliverTx?.info,
      tags: deliverTx?.tags,
    };
  }

  /**
   * create message
   * @param  {[type]} txMsg:{type:string, value:any} message
   * @return {[type]} message instance of types.Msg
   */
  createMsg(txMsg: { type: string, value: any }) {
    let msg: any = {};
    switch (txMsg.type) {
      //bank
      case types.TxType.MsgSend: {
        msg = new types.MsgSend(txMsg.value)
        break;
      }
      case types.TxType.MsgMultiSend: {
        msg = new types.MsgMultiSend(txMsg.value)
        break;
      }
      //staking
      case types.TxType.MsgDelegate: {
        msg = new types.MsgDelegate(txMsg.value);
        break;
      }
      case types.TxType.MsgUndelegate: {
        msg = new types.MsgUndelegate(txMsg.value);
        break;
      }
      case types.TxType.MsgBeginRedelegate: {
        msg = new types.MsgRedelegate(txMsg.value);
        break;
      }
      //distribution
      case types.TxType.MsgWithdrawDelegatorReward: {
        msg = new types.MsgWithdrawDelegatorReward(txMsg.value);
        break;
      }
      case types.TxType.MsgSetWithdrawAddress: {
        msg = new types.MsgSetWithdrawAddress(txMsg.value);
        break;
      }
      case types.TxType.MsgWithdrawValidatorCommission: {
        msg = new types.MsgWithdrawValidatorCommission(txMsg.value);
        break;
      }
      case types.TxType.MsgFundCommunityPool: {
        msg = new types.MsgFundCommunityPool(txMsg.value);
        break;
      }
      //token
      case types.TxType.MsgIssueToken: {
        msg = new types.MsgIssueToken(txMsg.value);
        break;
      }
      case types.TxType.MsgEditToken: {
        msg = new types.MsgEditToken(txMsg.value);
        break;
      }
      case types.TxType.MsgMintToken: {
        msg = new types.MsgMintToken(txMsg.value);
        break;
      }
      case types.TxType.MsgTransferTokenOwner: {
        msg = new types.MsgTransferTokenOwner(txMsg.value);
        break;
      }
      //coinswap
      case types.TxType.MsgAddLiquidity: {
          
          break;
      } 
      case types.TxType.MsgRemoveLiquidity: {
          
          break;
      } 
      case types.TxType.MsgSwapOrder: {
          
          break;
      }
      //nft
      case types.TxType.MsgIssueDenom: {
          msg = new types.MsgIssueDenom(txMsg.value)
          break;
      }
      case types.TxType.MsgMintNFT: {
          msg = new types.MsgMintNFT(txMsg.value)
          break;
      }
      case types.TxType.MsgEditNFT: {
          msg = new types.MsgEditNFT(txMsg.value)
          break;
      }
      case types.TxType.MsgTransferNFT: {
          msg = new types.MsgTransferNFT(txMsg.value)
          break;
      }
      case types.TxType.MsgBurnNFT: {
          msg = new types.MsgBurnNFT(txMsg.value)
          break;
      }
      default: {
          throw new SdkError("not exist tx type",CODES.InvalidType);
      }
    }
    return msg;
  }
}