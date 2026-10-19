trigger RDS_SBQQ_Subscription_CpqGuard on SBQQ__Subscription__c (before insert, before update) {
    RDS_CpqTriggerGuard.disableIfNeeded();
}