import { Interface } from 'ethers/lib/utils';
import { assert } from 'ts-essentials';
import { OptimalSwapExchange } from '@paraswap/core';
import SwapERC20 from '@airswap/swap-erc20/build/contracts/SwapERC20.sol/SwapERC20.json';
import { getCostByPricing } from '@airswap/utils';

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
import { AirSwapRegistry } from './registry';
import {
  getServerPricingKey,
  getPoolIdentifier,
  getAllPricingERC20,
  getOrderERC20,
  caster,
} from './utils';

import { Pricing } from '@airswap/utils';

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
  private worker: Fetcher<any> | null = null;
  private overrideServerURLs: string[] = [];

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

  /**
   * @name initializePricing
   * @description Called by the engine at startup
   */
  async initializePricing(blockNumber: number): Promise<void> {
    // Access potentially untyped override field safely
    this.overrideServerURLs = (
      this.dexHelper.config.data as any
    ).airSwapOverrideServerURLs;

    // Fallback: use environment variable directly if not provided in config (tests)
    if (!this.overrideServerURLs || this.overrideServerURLs.length === 0) {
      const envOverride = process.env[`AIRSWAP_SERVER_URLS_${this.network}`];
      if (envOverride) {
        this.overrideServerURLs = envOverride.split(',');
      }
    }

    this.registry = new AirSwapRegistry(
      this.dexKey,
      this.network,
      this.dexHelper,
      this.logger,
    );

    if (!this.dexHelper.config.isSlave) {
      // Only poll pricing if this instance is not a slave

      if (this.overrideServerURLs.length) {
        // Poll a specific list of URLs from config
        this.startWorker(this.overrideServerURLs);
      } else {
        // Poll active URLs; restart poller when updated
        this.registry.setUpdateCallback(this.startWorker.bind(this));
        this.registry.initialize(blockNumber, {
          forceRegenerate: true,
        });
      }
    }
  }

  /**
   * @name releaseResources
   * @description Called by the adapter when server URLs change
   * @param urls string[] array of URLs to poll
   */
  startWorker(urls: string[]): void {
    this.worker?.stopPolling();

    // Start a Fetcher to update pricing on an interval
    this.worker = new Fetcher<any>(
      this.dexHelper.httpRequest,
      urls.map(url => ({
        info: {
          requestOptions: { url },
          requestFunc: (options: any) =>
            getAllPricingERC20(options, this.dexHelper),
          caster: (data: unknown): any[] => {
            let body: any = data;

            // If Axios returned raw string, parse it
            if (typeof body === 'string') {
              try {
                body = JSON.parse(body);
              } catch {
                return [];
              }
            }

            if (Array.isArray(body?.result)) {
              return body.result;
            }

            if (Array.isArray(body)) {
              return body;
            }

            return [];
          },
        },
        handler: async (levels: any[]) => {
          this.logger.debug(
            `Received levels type: ${Array.isArray(levels)} length: ${
              levels?.length
            }`,
          );
          if (!levels || !levels.length) {
            this.logger.warn(`Invalid pricing payload from ${url}`);
            return;
          }
          await this.dexHelper.cache.rawset(
            getServerPricingKey(url),
            JSON.stringify(levels),
            CACHE_TTL,
          );
        },
      })),
      POLLING_INTERVAL,
      this.logger,
    );
    this.worker.startPolling();
  }

  /**
   * @name releaseResources
   * @description Called by the engine at shutdown
   */
  releaseResources(): void {
    this.worker?.stopPolling();
  }

  /**
   * @name getPoolIdentifiers
   * @description Called by the engine to get pool identifiers for a token pair
   * @param quoteToken the first token of the pair
   * @param baseToken the second token of the pair
   * @param side either sell or buy
   * @param blockNumber not used
   */
  async getPoolIdentifiers(
    quoteToken: Token,
    baseToken: Token,
    side: SwapSide,
    _: number,
  ): Promise<string[]> {
    // Prefer explicit overrides when provided and *non-empty*; otherwise ask
    // the registry for servers supporting the token pair.
    const fetchedURLs =
      this.overrideServerURLs && this.overrideServerURLs.length
        ? this.overrideServerURLs
        : this.registry?.getServerURLs(quoteToken.address, baseToken.address);

    const serverURLs: string[] = fetchedURLs ?? [];
    let tokenOne: Token;
    let tokenTwo: Token;
    if (side === SwapSide.SELL) {
      tokenOne = this.dexHelper.config.wrapETH(quoteToken);
      tokenTwo = this.dexHelper.config.wrapETH(baseToken);
    } else {
      tokenOne = this.dexHelper.config.wrapETH(baseToken);
      tokenTwo = this.dexHelper.config.wrapETH(quoteToken);
    }
    // Our pools are servers so identifiers include URL
    return serverURLs?.map(url =>
      getPoolIdentifier(this.dexKey, tokenOne, tokenTwo, url),
    );
  }

  /**
   * @name getPricesVolume
   * @description Called by the engine to get pricing for a token pair
   * @param quoteToken the first token of the pair
   * @param baseToken the second token of the pair
   * @param amounts the amounts to get prices for
   * @param side either sell or buy
   * @param blockNumber
   * @param limitPools a set of pool identifiers to use
   */
  async getPricesVolume(
    quoteToken: Token,
    baseToken: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    limitPools?: string[],
  ): Promise<null | ExchangePrices<AirSwapOrderResponse>> {
    const poolIdentifiers =
      limitPools ??
      (await this.getPoolIdentifiers(quoteToken, baseToken, side, blockNumber));

    const result: ExchangePrices<AirSwapOrderResponse> = [];

    for (const poolIdentifier of poolIdentifiers) {
      const prices: bigint[] = [];
      const url = decodeURIComponent(poolIdentifier.split('-')[3]);
      const serverPricingKey = getServerPricingKey(url);

      // Retrieve cached pricing published by the worker
      let cached = await this.dexHelper.cache.rawget(serverPricingKey);

      // If cache is empty (e.g., very first access before worker saved data),
      // perform a direct, synchronous fetch to the maker to obtain pricing so
      // that callers don't receive empty results.
      if (!cached) {
        try {
          const resp = await getAllPricingERC20({ url }, this.dexHelper);
          if (resp && Array.isArray((resp as any).data?.result)) {
            cached = JSON.stringify((resp as any).data.result);
            // Store in cache for subsequent reads (short TTL like worker).
            await this.dexHelper.cache.rawset(
              serverPricingKey,
              cached,
              CACHE_TTL,
            );
          }
        } catch (e) {
          this.logger.warn('Direct pricing fetch failed', url, e);
        }
      }

      if (cached) {
        const pricing: Pricing[] = JSON.parse(cached) || [];

        for (const amount of amounts) {
          try {
            // Map Paraswap side semantics to maker-side semantics.
            // Maker pricing defines:
            //   bid → maker buys baseToken, paying in quoteToken
            //   ask → maker sells baseToken, receiving quoteToken
            //
            // Paraswap SELL (we provide quoteToken, receive baseToken)
            //   → maker is BUYER of quoteToken, so we need BID prices.
            // Paraswap BUY (we provide quoteToken, receive baseToken)
            //   → maker is SELLER of baseToken, so we need ASK prices.

            const isSell = side === SwapSide.SELL;

            // Maker API: 'sell' -> use bid levels (maker buys baseToken),
            // 'buy'  -> use ask levels (maker sells baseToken).
            const makerSide = isSell ? 'sell' : 'buy';

            // Paraswap SELL: srcToken (quoteToken param) is being sold, so it
            // must be the maker's baseToken.  BUY keeps original orientation.
            const lookupBase = isSell ? quoteToken.address : baseToken.address;
            const lookupQuote = isSell ? baseToken.address : quoteToken.address;

            const price = getCostByPricing(
              makerSide,
              amount.toString(),
              lookupBase,
              lookupQuote,
              pricing,
            );
            prices.push(BigInt(price ?? 0));
          } catch (e) {
            prices.push(BigInt(0));
            this.logger.warn('getPricesVolume', url, e);
          }
        }
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
    }
    return result;
  }

  /**
   * @name preProcessTransaction
   * @description Called by the engine to get a signed order
   * @param optimalSwapExchange order request params
   * @param quoteToken the first token of the pair
   * @param baseToken the second token of the pair
   * @param side either sell or buy
   * @param options transaction options
   */
  async preProcessTransaction(
    optimalSwapExchange: OptimalSwapExchange<AirSwapOrderResponse>,
    quoteToken: Token,
    baseToken: Token,
    side: SwapSide,
    options: PreprocessTransactionOptions,
  ): Promise<[OptimalSwapExchange<AirSwapOrderResponse>, ExchangeTxInfo]> {
    const url = optimalSwapExchange.data?.url;
    assert(
      !!url,
      `${this.dexKey}-${this.network}: url was not provided to preProcessTransaction`,
    );

    // Call the server to get an order
    const order = await getOrderERC20(
      side,
      this.dexHelper,
      url,
      this.network.toString(),
      this.swapERC20Address,
      baseToken.address,
      optimalSwapExchange.srcAmount,
      quoteToken.address,
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

  /**
   * @name getSimpleParam
   * @description Called by the engine to get a signed order
   * @param quoteToken the first token of the pair
   * @param baseToken the second token of the pair
   * @param quoteAmount the amount of quoteToken
   * @param baseAmount the amount of baseToken
   * @param side either sell or buy
   */
  async getSimpleParam(
    quoteToken: string,
    baseToken: string,
    quoteAmount: string,
    baseAmount: string,
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

  /**
   * @name getTopPoolsForToken
   * @description Called by the engine to get token pool sizes
   * @param tokenAddress the address of the token
   * @param limit max number of results
   */
  async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    // TODO
    return [];
  }

  /**
   * @name getTokenFromAddress
   * @description Called by the engine to get token metadata
   * @param address the address of the token
   */
  getTokenFromAddress?(address: Address): Token {
    return { address, decimals: 0 };
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
}
