<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { differenceInSeconds } from 'date-fns';
import { useIntervalFn } from '@vueuse/core';

import useNumbers from '@/composables/useNumbers';
import useUserClaimsQuery from '@/composables/queries/useUserClaimsQuery';
import useBreakpoints from '@/composables/useBreakpoints';

import { TOKENS } from '@/constants/tokens';
import { bnum } from '@/lib/utils';
import { claimRewards } from '@/services/claim/claim.service';
import useWeb3 from '@/services/web3/useWeb3';
import useEthers from '@/composables/useEthers';
import useTransactions from '@/composables/useTransactions';
import useTokens from '@/composables/useTokens';
import { coingeckoService } from '@/services/coingecko/coingecko.service';
import { configService } from '@/services/config/config.service';
import { oneSecondInMs } from '@/composables/useTime';

const isClaiming = ref(false);
const rewardsEstimateSinceTimestamp = ref('0');

// COMPOSABLES
const { upToLargeBreakpoint } = useBreakpoints();
const userClaimsQuery = useUserClaimsQuery();
const { fNum } = useNumbers();
const {
  appNetworkConfig,
  account,
  getProvider,
  isMainnet,
  isPolygon,
  isArbitrum,
  isMismatchedNetwork
} = useWeb3();
const { txListener } = useEthers();
const { addTransaction } = useTransactions();
const { priceFor, tokens } = useTokens();

const BALTokenAddress = TOKENS.AddressMap[appNetworkConfig.key].BAL;

// COMPUTED
const userClaims = computed(() =>
  userClaimsQuery.isSuccess.value ? userClaimsQuery.data?.value : null
);

const userClaimsLoading = computed(
  () => userClaimsQuery.isLoading.value || userClaimsQuery.isIdle.value
);

const totalRewardsBAL = computed(() => {
  if (userClaims.value != null && userClaims.value.pendingClaimsMap != null) {
    const availableToClaim =
      userClaims.value.pendingClaimsMap[BALTokenAddress]?.availableToClaim;
    if (userClaims.value.currentRewardsEstimate != null) {
      return bnum(availableToClaim)
        .plus(userClaims.value.currentRewardsEstimate.rewards)
        .toString();
    }
    return availableToClaim;
  }
  return null;
});

// having multiple unclaimed weeks may cause the browser to freeze (> 5)
const shouldShowClaimFreezeWarning = computed(() =>
  userClaims.value != null ? userClaims.value.pendingClaims.length > 5 : false
);

const availableToClaimTokens = computed(() => {
  if (userClaims.value != null) {
    return userClaims.value.pendingClaims.map(
      ({ availableToClaim, tokenClaimInfo }) => ({
        token: tokenClaimInfo.token,
        symbol: tokens.value[tokenClaimInfo.token]?.symbol,
        amount: availableToClaim,
        fiatValue: bnum(availableToClaim)
          .times(priceFor(tokenClaimInfo.token))
          .toString()
      })
    );
  }
  return [];
});

useIntervalFn(async () => {
  if (
    userClaims.value != null &&
    userClaims.value.currentRewardsEstimate != null
  ) {
    const diffInSeconds = differenceInSeconds(
      new Date(),
      new Date(userClaims.value.currentRewardsEstimate.timestamp)
    );
    rewardsEstimateSinceTimestamp.value = bnum(diffInSeconds)
      .times(userClaims.value.currentRewardsEstimate.velocity)
      .toString();
  }
}, oneSecondInMs);

watch(account, () => {
  rewardsEstimateSinceTimestamp.value = '0';
});

watch(isMismatchedNetwork, () => {
  userClaimsQuery.refetch.value();
});

// METHODS
async function claimAvailableRewards() {
  if (userClaims.value != null) {
    isClaiming.value = true;
    try {
      const tx = await claimRewards(
        appNetworkConfig.chainId,
        getProvider(),
        account.value,
        userClaims.value.pendingClaims
      );

      addTransaction({
        id: tx.hash,
        type: 'tx',
        action: 'claim',
        summary: userClaims.value.pendingClaims
          .map(
            pendingClaim =>
              `${fNum(pendingClaim.availableToClaim, 'token_fixed')} ${
                tokens.value[pendingClaim.tokenClaimInfo.token]?.symbol
              }`
          )
          .join(', ')
      });

      txListener(tx, {
        onTxConfirmed: () => {
          isClaiming.value = false;
          userClaimsQuery.refetch.value();
        },
        onTxFailed: () => {
          isClaiming.value = false;
        }
      });
    } catch (e) {
      console.log(e);
      isClaiming.value = false;
    }
  }
}
</script>

<template>
  <BalPopover no-pad>
    <template v-slot:activator>
      <BalBtn
        color="white"
        class="mr-2 text-base"
        :size="upToLargeBreakpoint ? 'md' : 'sm'"
        :circle="upToLargeBreakpoint"
      >
        <StarsIcon
          :class="{ 'mr-2': !upToLargeBreakpoint }"
          v-if="upToLargeBreakpoint ? !userClaimsLoading : true"
        />
        <BalLoadingIcon size="sm" v-if="userClaimsLoading" />
        <span class="hidden lg:block" v-else>{{
          totalRewardsBAL != null ? fNum(totalRewardsBAL, 'token_fixed') : '0'
        }}</span>
      </BalBtn>
    </template>
    <div class="divide-y dark:divide-gray-900 w-72" v-if="userClaims != null">
      <div class="p-3">
        <h5 class="text-lg mb-3">{{ $t('liquidityMining') }}</h5>
        <div class="text-sm text-gray-600 mb-1" v-if="isPolygon">
          {{ $t('airdropExplainer') }}
        </div>
        <BalAlert
          v-if="shouldShowClaimFreezeWarning && !isPolygon"
          title="Too many claims"
          :description="$t('claimFreezeWarning')"
          type="warning"
          size="sm"
          class="mb-3"
        />
        <div v-if="!isPolygon" class="text-sm text-gray-600 mb-1">
          {{ $t('availableToClaim') }}
        </div>
        <div v-if="!isPolygon">
          <template
            v-for="availableToClaimToken in availableToClaimTokens"
            :key="availableToClaimToken.token"
          >
            <div class="flex justify-between items-center mb-2">
              <div class="text-lg font-bold">
                {{
                  Number(availableToClaimToken.amount) > 0
                    ? fNum(availableToClaimToken.amount, 'token')
                    : 0
                }}
                {{ availableToClaimToken.symbol }}
              </div>
              <div>
                {{ fNum(availableToClaimToken.fiatValue, 'usd') }}
              </div>
            </div>
          </template>
        </div>
        <BalBtn
          v-if="!isPolygon"
          color="gradient"
          size="md"
          block
          class="mb-1 "
          :loading="isClaiming"
          :loading-label="$t('claiming')"
          @click="claimAvailableRewards"
          >{{ $t('claim') }} All</BalBtn
        >
      </div>
      <div class="p-3">
        <div class="text-sm text-gray-600 mb-1">
          {{ $t('pendingEstimate') }}
        </div>
        <div class="flex justify-between items-center mb-2">
          <div class="text-lg font-bold">
            -
          </div>
          <div>
            -
          </div>
        </div>
      </div>
      <!-- <div class="p-3 text-sm" v-else-if="totalRewards == 0">
        {{ $t('liquidityProviderCopy') }}
      </div> -->
    </div>
  </BalPopover>
</template>
