trigger RDS_Contract_CpqGuard on Contract (before insert, before update) {
    RDS_CpqTriggerGuard.disableIfNeeded();
}