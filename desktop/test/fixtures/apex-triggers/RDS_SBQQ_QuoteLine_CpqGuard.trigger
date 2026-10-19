trigger RDS_SBQQ_QuoteLine_CpqGuard on SBQQ__QuoteLine__c (before insert, before update) {
    RDS_CpqTriggerGuard.disableIfNeeded();
}