import { Client } from '../client';
import { Crypto } from '../utils/crypto';
import * as types from '../types';
import { SdkError } from '../errors';
import { EventQueryBuilder, EventKey, EventAction } from '../types';

/**
 * This module is mainly used to transfer coins between accounts,
 * query account balances, and provide common offline transaction signing and broadcasting methods.
 * In addition, the available units of tokens in the IRIShub system are defined using [coin-type](https://www.irisnet.org/docs/concepts/coin-type.html).
 *
 * [More Details](https://www.irisnet.org/docs/features/bank.html)
 *
 * @category Modules
 * @since v0.17
 */
export class Bank {
  /** @hidden */
  private client: Client;
  /** @hidden */
  constructor(client: Client) {
    this.client = client;
  }

  /**
   * Get the cointype of a token
   *
   * @deprecated Please refer to [[token.queryToken]]
   * @since v0.17
   */
  queryCoinType(tokenName: string) {
    throw new SdkError('Not supported');
  }

  /**
   * Query account info from blockchain
   * @param address Bech32 address
   * @returns
   * @since v0.17
   */
  queryAccount(address: string): Promise<types.BaseAccount> {
    return Promise.all([
      this.client.rpcClient.abciQuery<types.BaseAccount>(
      'custom/auth/account',
      {
        address: address,
      }
    ),
    this.client.rpcClient.abciQuery<types.Coin[]>(
      'custom/bank/all_balances',
      {
        address: address,
      }
    )
    ]

    ).then(res => {
      const acc = res[0];
      const bal = res[1];
      acc.coins = bal;
      return acc;
    });
  }

  /**
   * Query total supply
   * @param denom Denom of the token
   * @returns
   * @since v1.0
   */
  queryTotalSupply(denom?: string): Promise<types.Coin[]> {
    let path;
    let param;

    if (!denom) {
      path = 'custom/bank/total_supply';
      param = {
        Page: '1',
        Limit: '0'
      };
    } else {
      path = 'custom/bank/supply_of';
      param = {
        Denom: denom
      }
    }
    return this.client.rpcClient.abciQuery<types.Coin[]>(
      path, param
    );
  }

  /**
   * Send coins
   * @param to Recipient bech32 address
   * @param amount Coins to be sent
   * @param baseTx { types.BaseTx }
   * @returns
   * @since v0.17
   */
  async send(
    to: string,
    amount: types.Coin[],
    baseTx: types.BaseTx
  ): Promise<types.TxResult> {
    // Validate bech32 address
    if (!Crypto.checkAddress(to, this.client.config.bech32Prefix.AccAddr)) {
      throw new SdkError('Invalid bech32 address');
    }
    const from = this.client.keys.show(baseTx.from);
    const msgs: any[] = [
      {
        type:types.TxType.MsgSend,
        value:{
          from_address:from,
          to_address:to,
          amount
        }
      }
    ];
    return this.client.tx.buildAndSend(msgs, baseTx);
  }

  /**
   * multiSend coins
   * @param to Recipient bech32 address
   * @param amount Coins to be sent
   * @param baseTx { types.BaseTx }
   * @returns
   * @since v0.17
   */
  async multiSend(
    to: string,
    amount: types.Coin[],
    baseTx: types.BaseTx
  ): Promise<types.TxResult> {
    // Validate bech32 address
    if (!Crypto.checkAddress(to, this.client.config.bech32Prefix.AccAddr)) {
      throw new SdkError('Invalid bech32 address');
    }
    const from = this.client.keys.show(baseTx.from);
    const coins = amount;
    const msgs: any[] = [
      {
        type:types.TxType.MsgMultiSend,
        value:{
          inputs:[{ address: from, coins }],
          outputs:[{ address: to, coins }],
        }
      }
    ];
    return this.client.tx.buildAndSend(msgs, baseTx);
  }

  /**
   * Subscribe Send Txs
   * @param conditions Query conditions for the subscription
   * @param callback A function to receive notifications
   * @returns
   * @since v0.17
   */
  subscribeSendTx(
    conditions: { from?: string; to?: string },
    callback: (error?: SdkError, data?: types.EventDataMsgSend) => void
  ): types.EventSubscription {
    const queryBuilder = new EventQueryBuilder().addCondition(
      new types.Condition(EventKey.Action).eq(EventAction.Send)
    );

    if (conditions.from) {
      queryBuilder.addCondition(
        new types.Condition(EventKey.Sender).eq(conditions.from)
      );
    }
    if (conditions.to) {
      queryBuilder.addCondition(
        new types.Condition(EventKey.Recipient).eq(conditions.to)
      );
    }

    const subscription = this.client.eventListener.subscribeTx(
      queryBuilder,
      (error, data) => {
        if (error) {
          callback(error);
          return;
        }
        data?.tx.value.msg.forEach(msg => {
          if (msg.type !== 'irishub/bank/Send') return;
          const msgSend = msg as types.MsgMultiSend;
          const height = data.height;
          const hash = data.hash;
          msgSend.value.inputs.forEach((input: types.Input, index: number) => {
            const from = input.address;
            const to = msgSend.value.outputs[index].address;
            const amount = input.coins;
            callback(undefined, { height, hash, from, to, amount });
          });
        });
      }
    );
    return subscription;
  }
}
