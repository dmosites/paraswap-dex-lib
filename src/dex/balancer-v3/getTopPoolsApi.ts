import axios from 'axios';
import { apiUrl, BalancerV3Config, disabledPoolIds } from './config';
import { HooksConfigMap } from './hooks/balancer-hook-event-subscriber';
import { getUniqueHookNames } from './utils';
import { ReClammApiName } from './reClammPool';
interface PoolToken {
  address: string;
  decimals: number;
  canUseBufferForSwaps: boolean | null;
  underlyingToken: {
    address: string;
    decimals: number;
  } | null;
}

export interface Pool {
  address: string;
  type: string;
  poolTokens: PoolToken[];
  dynamicData: {
    totalLiquidity: string;
  };
  hook: {
    address: string;
  } | null;
}

interface QueryResponse {
  data: {
    aggregatorPools: Pool[];
  };
}

function createQuery(
  networkId: number,
  poolsFilter: string[],
  hooks: string,
  count: number,
): string {
  const disabledPoolIdsString = disabledPoolIds.BalancerV3[networkId]
    ?.map(p => `"${p}"`)
    .join(', ');

  const networkString = BalancerV3Config.BalancerV3[networkId].apiNetworkName;
  const poolIdString = poolsFilter.map(a => `"${a}"`).join(', ');
  // Build the where clause conditionally
  const whereClause = {
    chainIn: networkString,
    protocolVersionIn: 3,
    idIn: `[${poolIdString}]`,
    ...(disabledPoolIdsString && { idNotIn: `[${disabledPoolIdsString}]` }),
    includeHooks: `[${hooks}]`,
  };

  // Convert where clause to string, filtering out undefined values
  const whereString = Object.entries(whereClause)
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ');
  return `
    query MyQuery {
      aggregatorPools(
        where: {${whereString}}
        first: ${count}
        orderBy: totalLiquidity
        orderDirection: desc
      ) {
        address
        type
        poolTokens {
          address
          decimals
          canUseBufferForSwaps
          underlyingToken {
            address
            decimals
          }
        }
        dynamicData {
          totalLiquidity
        }
        hook {
          address
        }
      }
    }
  `;
}

export async function getTopPoolsApi(
  networkId: number,
  poolsFilter: string[],
  count: number,
  hooksConfigMap: HooksConfigMap,
): Promise<Pool[]> {
  try {
    const query = createQuery(
      networkId,
      poolsFilter,
      getUniqueHookNames(hooksConfigMap),
      count,
    );
    const response = await axios.post<QueryResponse>(
      apiUrl,
      {
        query,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );

    const pools = response.data.data.aggregatorPools
      .filter(
        pool =>
          !pool.hook ||
          pool.type === ReClammApiName || // In reClamm the pool is also its own hook. We don't track hook state as its not needed for pricing
          (pool.hook && pool.hook.address.toLowerCase() in hooksConfigMap),
      )
      .map(pool => ({
        ...pool,
        poolTokens: pool.poolTokens.map(t => ({
          ...t,
          underlyingToken: t.canUseBufferForSwaps ? t.underlyingToken : null,
        })),
      }));
    return pools;
  } catch (error) {
    // console.error('Error executing GraphQL query:', error);
    throw error;
  }
}
