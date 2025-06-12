import { v4 as uuid } from 'uuid';
import joi from 'joi';
import { Token } from '../../types';
import { validateAndCast } from '../../lib/validators';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { SwapSide } from '../../constants';
import { AirSwapPricingResponse } from './types';
import BigNumber from 'bignumber.js';

export function getServerPricingKey(url: string): string {
  return `${encodeURIComponent(url)}-PRICING`.toLowerCase();
}

export function getPoolKey(srcAddress: string, destAddress: string): string {
  return `${srcAddress}-${destAddress}-POOL`.toLowerCase();
}

export function getPoolIdentifier(
  dexKey: string,
  srcToken: Token,
  destToken: Token,
  url: string,
): string {
  return `${dexKey}-${destToken.address}-${
    srcToken.address
  }-${encodeURIComponent(url)}`;
}

export async function getAllPricingERC20(options: any, dexHelper: IDexHelper) {
  return await dexHelper.httpRequest
    .request({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      data: {
        id: uuid(),
        method: 'getAllPricingERC20',
        params: {},
      },
      ...options,
    })
    .then(res => {
      if (res && (res as any).data === undefined) {
        (res as any).data = null;
      }
      return res;
    });
}

export async function getOrderERC20(
  side: SwapSide,
  dexHelper: IDexHelper,
  url: string,
  chainId: string,
  swapContract: string,
  signerToken: string,
  amount: string,
  senderToken: string,
  senderWallet: string,
  minExpiry: string,
  proxyingFor: string,
) {
  const params: any = {
    chainId,
    swapContract,
    signerToken,
    senderToken,
    senderWallet,
    minExpiry,
    proxyingFor,
  };
  let method;
  if (side === SwapSide.SELL) {
    method = 'getSignerSideOrderERC20';
    params.senderAmount = amount;
  } else {
    method = 'getSenderSideOrderERC20';
    params.signerAmount = amount;
  }
  const response = await dexHelper.httpRequest.request({
    url,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    data: {
      id: uuid(),
      method,
      params,
    },
  });
  return response.data.result;
}

export function remove(array: string[], item: string) {
  let length = array.length;
  while (length--) {
    if (array[length] === item) {
      array.splice(length, 1);
      break;
    }
  }
  return array;
}

export const pricingResponseValidator = joi.object({
  jsonrpc: joi.string(),
  id: joi.string(),
  result: joi.array().items({
    baseToken: joi.string().required(),
    quoteToken: joi.string().required(),
    minimum: joi.string().optional(),
    bid: joi
      .array()
      .items(
        joi.array().items(joi.string().required(), joi.string().required()),
      ),
    ask: joi
      .array()
      .items(
        joi.array().items(joi.string().required(), joi.string().required()),
      ),
  }),
});

export function caster(data: unknown) {
  return validateAndCast<AirSwapPricingResponse>(
    data,
    pricingResponseValidator,
  );
}

export function getPriceForAmount(
  side: 'buy' | 'sell',
  amount: string,
  baseToken: string,
  quoteToken: string,
  pricing: any[],
) {
  for (const entry of pricing) {
    if (
      entry.baseToken.toLowerCase() === baseToken.toLowerCase() &&
      entry.quoteToken.toLowerCase() === quoteToken.toLowerCase()
    ) {
      if (entry.minimum && new BigNumber(amount).lt(entry.minimum || 0)) {
        throw new Error(
          `Requested amount ${amount} does not meet minimum ${entry.minimum}`,
        );
      }
      return side === 'buy'
        ? calculateCost(amount, entry.ask)
        : calculateCost(amount, entry.bid);
    }
  }
  throw new Error(
    `Requested pair ${quoteToken}/${baseToken} not found in provided pricing`,
  );
}

export function calculateCost(amount: string, pricing: any) {
  // TODO: Formula support
  if (typeof pricing !== 'string') {
    return calculateCostFromLevels(amount, pricing);
  }
  return null;
}

export function calculateCostFromLevels(
  amount: string,
  levels: [string, string][],
) {
  const totalAmount = new BigNumber(amount);
  const totalAvailable = new BigNumber(levels[levels.length - 1][0]);
  let totalCost = new BigNumber(0);
  let previousLevel = new BigNumber(0);

  if (totalAmount.gt(totalAvailable)) {
    throw new Error(
      `Requested amount (${totalAmount.toFixed()}) exceeds maximum available (${totalAvailable.toFixed()}).`,
    );
  }

  for (let i = 0; i < levels.length; i++) {
    let incrementalAmount: BigNumber;
    if (totalAmount.gt(new BigNumber(levels[i][0]))) {
      incrementalAmount = new BigNumber(levels[i][0]).minus(previousLevel);
    } else {
      incrementalAmount = new BigNumber(totalAmount).minus(previousLevel);
    }
    totalCost = totalCost.plus(
      new BigNumber(incrementalAmount).multipliedBy(levels[i][1]),
    );
    previousLevel = new BigNumber(levels[i][0]);
    if (totalAmount.lt(previousLevel)) break;
  }
  // Convert to whole-number string for BigInt parsing.
  // Round DOWN (floor) so we never quote higher than the true calculated cost; makers remain free to under-quote.
  return totalCost.decimalPlaces(0, BigNumber.ROUND_FLOOR).toFixed();
}
