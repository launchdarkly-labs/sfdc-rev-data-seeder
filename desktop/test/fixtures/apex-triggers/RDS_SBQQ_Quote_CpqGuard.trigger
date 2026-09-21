trigger RDS_SBQQ_Quote_CpqGuard on SBQQ__Quote__c (before insert, before update) {
    RDS_CpqTriggerGuard.disableIfNeeded();
}