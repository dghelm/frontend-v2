import { computed, reactive } from 'vue';
import { useQuery } from 'vue-query';
import { UseQueryOptions } from 'react-query/types';

import QUERY_KEYS from '@/constants/queryKeys';

import {
  getPendingClaims,
  getCurrentRewardsEstimate,
  CurrentRewardsEstimate,
  PendingClaimsMap,
  PendingClaims
} from '@/services/claim/claim.service';

import useWeb3 from '@/services/web3/useWeb3';
import useNetwork from '@/composables/useNetwork';

type UserClaimsQueryResponse = {
  pendingClaims: PendingClaims[];
  pendingClaimsMap: PendingClaimsMap | null;
  currentRewardsEstimate: CurrentRewardsEstimate;
};

export default function useUserClaimsQuery(
  options: UseQueryOptions<UserClaimsQueryResponse> = {}
) {
  // COMPOSABLES
  const { account, isWalletReady, appNetworkConfig, getProvider } = useWeb3();
  const { networkId } = useNetwork();

  // DATA
  const queryKey = reactive(QUERY_KEYS.Claims.All(networkId, account));

  // COMPUTED
  const isQueryEnabled = computed(
    () => isWalletReady.value && account.value != null
  );

  // METHODS
  const queryFn = async () => {
    const [pendingClaimsMap, currentRewardsEstimate] = await Promise.all([
      getPendingClaims(getProvider(), account.value),
      getCurrentRewardsEstimate(appNetworkConfig.chainId, account.value)
    ]);

    const pendingClaims = Object.values(pendingClaimsMap ?? []);

    return {
      pendingClaims,
      pendingClaimsMap,
      currentRewardsEstimate
    };
  };

  const queryOptions = reactive({
    enabled: isQueryEnabled,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    ...options
  });

  return useQuery<UserClaimsQueryResponse>(queryKey, queryFn, queryOptions);
}
