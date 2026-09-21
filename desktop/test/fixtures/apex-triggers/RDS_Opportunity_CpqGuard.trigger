trigger RDS_Opportunity_CpqGuard on Opportunity (before insert, before update) {
    RDS_CpqTriggerGuard.disableIfNeeded();
}