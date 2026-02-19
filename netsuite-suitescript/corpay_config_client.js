/**
 * Client-side script for the CorpayOne Configuration Suitelet.
 *
 * Provides field validation and UI enhancements for the configuration dashboard.
 *
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 */
define(['N/ui/dialog', 'N/currentRecord'], function (dialog, currentRecord) {

  function pageInit(context) {
    // Highlight required fields
    console.log('CorpayOne Configuration Dashboard loaded');
  }

  function saveRecord(context) {
    var record = currentRecord.get();

    // Validate that at least one subsidiary is configured
    var subCount = record.getLineCount({ sublistId: 'custpage_subsidiary_list' });
    var hasSubsidiary = false;
    for (var i = 0; i < subCount; i++) {
      var nsId = record.getSublistValue({ sublistId: 'custpage_subsidiary_list', fieldId: 'custpage_sub_ns_id', line: i });
      if (nsId) {
        hasSubsidiary = true;
        break;
      }
    }

    if (!hasSubsidiary) {
      dialog.alert({
        title: 'Configuration Required',
        message: 'Please configure at least one subsidiary mapping before saving.',
      });
      return false;
    }

    // Validate at least one default bank account
    var bankCount = record.getLineCount({ sublistId: 'custpage_bank_list' });
    var hasBank = false;
    for (var b = 0; b < bankCount; b++) {
      var bankAcct = record.getSublistValue({ sublistId: 'custpage_bank_list', fieldId: 'custpage_bank_ns_account', line: b });
      if (bankAcct) {
        hasBank = true;
        break;
      }
    }

    if (!hasBank) {
      dialog.alert({
        title: 'Configuration Required',
        message: 'Please configure at least one bank account for CorpayOne payments.',
      });
      return false;
    }

    return true;
  }

  function validateLine(context) {
    var record = currentRecord.get();

    if (context.sublistId === 'custpage_account_list') {
      var code = record.getCurrentSublistValue({ sublistId: 'custpage_account_list', fieldId: 'custpage_acct_corpay_code' });
      var nsAcct = record.getCurrentSublistValue({ sublistId: 'custpage_account_list', fieldId: 'custpage_acct_ns_account' });
      if (code && !nsAcct) {
        dialog.alert({ title: 'Validation', message: 'Please select a NetSuite GL Account for the mapping.' });
        return false;
      }
    }

    if (context.sublistId === 'custpage_tax_list') {
      var vatRate = record.getCurrentSublistValue({ sublistId: 'custpage_tax_list', fieldId: 'custpage_tax_vat_rate' });
      var nsCode = record.getCurrentSublistValue({ sublistId: 'custpage_tax_list', fieldId: 'custpage_tax_ns_code' });
      if (vatRate && !nsCode) {
        dialog.alert({ title: 'Validation', message: 'Please select a NetSuite Tax Code for the mapping.' });
        return false;
      }
    }

    return true;
  }

  return {
    pageInit: pageInit,
    saveRecord: saveRecord,
    validateLine: validateLine,
  };
});
