import { Interface } from 'ethers/lib/utils';
import { assert } from 'ts-essentials';
import { OptimalSwapExchange } from '@paraswap/core';
import SwapERC20 from '@airswap/swap-erc20/build/contracts/SwapERC20.sol/SwapERC20.json';
import { getPriceForAmount } from '@airswap/utils';
import { Pricing } from '@airswap/types';

import { Fetcher } from '../../lib/fetcher/fetcher';
import {
  Token,
  ExchangePrices,
  ExchangeTxInfo,
  PreprocessTransactionOptions,
  PoolLiquidity,
  SimpleExchangeParam,
  AdapterExchangeParam,
  Address,
  PoolPrices,
  Logger,
} from '../../types';

import { Network, SwapSide } from '../../constants';
import { SimpleExchange } from '../simple-exchange';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { IDex } from '../../dex/idex';
import { getDexKeysWithNetwork } from '../../utils';
import * as CALLDATA_GAS_COST from '../../calldata-gas-cost';

import { AirSwapConfig } from './config';
import { AirSwapOrderResponse } from './types';
import { AirSwapPricingResponse } from './types';
import { AirSwapRegistry } from './registry';
import {
  getServerPricingKey,
  getPoolIdentifier,
  getAllPricingERC20,
  getOrderERC20,
  caster,
} from './utils';

export const MIN_EXPIRY = 100000;
export const CACHE_TTL = 3000;
export const POLLING_INTERVAL = 3000;
export const GAS_COST = 100_000;

export class AirSwap
  extends SimpleExchange
  implements IDex<AirSwapOrderResponse>
{
  readonly isStatePollingDex = true;
  readonly hasConstantPriceLargeAmounts = false;
  readonly needWrapNative = true;
  readonly needsSequentialPreprocessing = true;
  readonly isFeeOnTransferSupported = false;

  protected swapInterface = new Interface(SwapERC20.abi);
  private swapERC20Address: string;

  private registry: AirSwapRegistry | null = null;
  private worker: Fetcher<AirSwapPricingResponse> | null = null;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(AirSwapConfig);
  logger: Logger;

  constructor(
    protected network: Network,
    public dexKey: string,
    readonly dexHelper: IDexHelper,
  ) {
    super(dexHelper, dexKey);
    this.logger = dexHelper.getLogger(dexKey);
    this.swapERC20Address = AirSwapConfig.AirSwap[network].swapERC20Address;
  }

  async initializePricing(blockNumber: number): Promise<void> {
    this.overrideServerURLs =
      this.dexHelper.config.data.airSwapOverrideServerURLs;
    this.registry = new AirSwapRegistry(
      this.dexKey,
      this.network,
      this.dexHelper,
      this.logger,
    );

    if (!this.dexHelper.config.isSlave) {
      if (this.overrideServerURLs.length) {
        this.startWorker(this.overrideServerURLs);
      } else {
        this.registry.subscribe(this.startWorker.bind(this));
        this.registry.initialize(blockNumber, {
          forceRegenerate: true,
        });
      }
    }
  }

  startWorker(urls: string[]): void {
    this.worker?.stopPolling();
    this.worker = new Fetcher(
      this.dexHelper.httpRequest,
      urls.map(url => ({
        info: {
          requestOptions: { url },
          requestFunc: (options: any) => {
            return getAllPricingERC20(options, this.dexHelper);
          },
          caster: caster.bind(this),
        },
        handler: async (resp: AirSwapPricingResponse) => {
          const serverPricingKey = getServerPricingKey(url);
          await this.dexHelper.cache.rawset(
            serverPricingKey,
            JSON.stringify(resp.result),
            CACHE_TTL,
          );
        },
      })),
      POLLING_INTERVAL,
      this.logger,
    );
    this.worker.startPolling();
  }

  releaseResources(): void {
    this.worker?.stopPolling();
  }

  overrideServerURLs: string[] = [];

  async getPoolIdentifiers(
    quoteToken: Token,
    baseToken: Token,
    side: SwapSide,
    _: number,
  ): Promise<string[]> {
    const serverURLs: string[] =
      this.overrideServerURLs ||
      this.registry?.getServerURLs(quoteToken.address, baseToken.address);
    let tokenOne: Token;
    let tokenTwo: Token;
    if (side === SwapSide.SELL) {
      tokenOne = this.dexHelper.config.wrapETH(quoteToken);
      tokenTwo = this.dexHelper.config.wrapETH(baseToken);
    } else {
      tokenOne = this.dexHelper.config.wrapETH(baseToken);
      tokenTwo = this.dexHelper.config.wrapETH(quoteToken);
    }
    return serverURLs?.map(url =>
      getPoolIdentifier(this.dexKey, tokenOne, tokenTwo, url),
    );
  }

  async getPricesVolume(
    baseToken: Token,
    quoteToken: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    limitPools?: string[],
  ): Promise<null | ExchangePrices<AirSwapOrderResponse>> {
    const poolIdentifiers =
      limitPools ??
      (await this.getPoolIdentifiers(baseToken, quoteToken, side, blockNumber));
    const result: ExchangePrices<AirSwapOrderResponse> = [];
    await poolIdentifiers.forEach(async poolIdentifier => {
      const prices: bigint[] = [];
      const url = decodeURIComponent(poolIdentifier.split('-')[3]);
      const serverPricingKey = getServerPricingKey(url);
      const cached = await this.dexHelper.cache.rawget(serverPricingKey);
      if (cached) {
        const pricing: Pricing[] = JSON.parse(cached) || [];
        amounts.forEach(async amount => {
          try {
            const price = getPriceForAmount(
              side === SwapSide.SELL ? 'sell' : 'buy',
              amount.toString(),
              baseToken.address,
              quoteToken.address,
              pricing,
            );
            if (price) prices.push(BigInt(price));
          } catch (e) {
            prices.push(BigInt(0));
            this.logger.warn('getPricesVolume', url, e);
          }
        });
      }
      result.push({
        gasCost: GAS_COST,
        exchange: this.dexKey,
        data: { url },
        prices,
        unit: BigInt(1),
        poolIdentifier: getPoolIdentifier(
          this.dexKey,
          this.dexHelper.config.wrapETH(baseToken),
          this.dexHelper.config.wrapETH(quoteToken),
          url,
        ),
        poolAddresses: [this.swapERC20Address],
      } as PoolPrices<AirSwapOrderResponse>);
    });
    return result;
  }

  async preProcessTransaction(
    optimalSwapExchange: OptimalSwapExchange<AirSwapOrderResponse>,
    baseToken: Token,
    quoteToken: Token,
    side: SwapSide,
    options: PreprocessTransactionOptions,
  ): Promise<[OptimalSwapExchange<AirSwapOrderResponse>, ExchangeTxInfo]> {
    const url = optimalSwapExchange.data?.url;
    assert(
      !!url,
      `${this.dexKey}-${this.network}: url was not provided to preProcessTransaction`,
    );

    const order = await getOrderERC20(
      side,
      this.dexHelper,
      url,
      this.network.toString(),
      this.swapERC20Address,
      quoteToken.address,
      optimalSwapExchange.srcAmount,
      baseToken.address,
      this.augustusAddress,
      MIN_EXPIRY.toString(),
      options.txOrigin,
    );

    return [
      {
        ...optimalSwapExchange,
        data: {
          url,
          order,
        },
      },
      { deadline: BigInt(order.expiry) },
    ];
  }

  async getSimpleParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: AirSwapOrderResponse,
    side: SwapSide,
  ): Promise<SimpleExchangeParam> {
    const { order } = data;

    assert(
      order !== undefined,
      `${this.dexKey}-${this.network}: order undefined`,
    );

    const values = [
      order.nonce,
      order.expiry,
      order.signerWallet,
      order.signerToken,
      order.signerAmount,
      order.senderToken,
      order.senderAmount,
      order.v,
      order.r,
      order.s,
    ];

    const swapData = this.swapInterface.encodeFunctionData('swapLight', values);

    return this.buildSimpleParamWithoutWETHConversion(
      order.senderToken,
      order.senderAmount,
      order.signerToken,
      order.signerAmount,
      swapData,
      this.swapERC20Address,
    );
  }

  async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    // TODO
    return [];
  }

  getTokenFromAddress?(address: Address): Token {
    return { address, decimals: 0 };
  }

  // @TODO PARASWAP
  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    return null;
  }
  // @TODO PARASWAP
  getCalldataGasCost(
    poolPrices: PoolPrices<AirSwapOrderResponse>,
  ): number | number[] {
    return CALLDATA_GAS_COST.DEX_NO_PAYLOAD;
  }
  // @TODO PARASWAP
  getAdapterParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: AirSwapOrderResponse,
    side: SwapSide,
  ): AdapterExchangeParam {
    // TODO: complete me!
    const { url } = data;

    // Encode here the payload for adapter
    const payload = '';

    return {
      targetExchange: url,
      payload,
      networkFee: '0',
    };
  }

  async updatePoolState(): Promise<void> {
    // Pricing is updated on an interval by the fetcher.
    return Promise.resolve();
  }

  async isBlacklisted(userAddress?: string | undefined): Promise<boolean> {
    return Promise.resolve(false);
  }

  async setBlacklist(userAddress: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}
