/**
 * CorpayOne Integration Configuration Dashboard (Suitelet)
 *
 * This SuiteScript 2.1 Suitelet provides an admin UI inside NetSuite
 * for configuring the CorpayOne integration. Similar to the Pleo NetSuite
 * SuiteApp dashboard, it allows admins to:
 *
 *   1. Map CorpayOne expense categories to NetSuite GL accounts
 *   2. Map CorpayOne VAT rates to NetSuite tax codes
 *   3. Select which bank account to use for CorpayOne payments
 *   4. Choose which subsidiary transactions should book into
 *   5. Configure general integration settings
 *
 * Deploy as a Suitelet in NetSuite:
 *   - Script Type: Suitelet
 *   - Entry Points: onRequest
 *   - Status: Released
 *   - Audience: Administrators
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define([
  'N/ui/serverWidget',
  'N/record',
  'N/search',
  'N/runtime',
  'N/https',
  'N/url',
  'N/log',
], function (serverWidget, record, search, runtime, https, url, log) {

  /**
   * The integration server base URL. Set this to wherever the
   * corpayone-netsuite-integration middleware is running.
   */
  var INTEGRATION_API_URL = runtime.getCurrentScript().getParameter({
    name: 'custscript_corpay_api_url',
  }) || 'http://localhost:3000';

  // ─── GET: Render the configuration dashboard ─────────────────────

  function onRequestGet(context) {
    var form = serverWidget.createForm({
      title: 'CorpayOne Integration Configuration',
    });

    form.clientScriptModulePath = './corpay_config_client.js';

    // ── Tab: Subsidiary ──────────────────────────────────────────
    form.addTab({
      id: 'custpage_tab_subsidiary',
      label: 'Subsidiary',
    });

    var subsidiarySublist = form.addSublist({
      id: 'custpage_subsidiary_list',
      type: serverWidget.SublistType.INLINEEDITOR,
      label: 'Subsidiary Mapping',
      tab: 'custpage_tab_subsidiary',
    });

    subsidiarySublist.addField({
      id: 'custpage_sub_ns_id',
      type: serverWidget.FieldType.SELECT,
      label: 'NetSuite Subsidiary',
      source: 'subsidiary',
    });
    subsidiarySublist.addField({
      id: 'custpage_sub_corpay_entity',
      type: serverWidget.FieldType.TEXT,
      label: 'CorpayOne Entity ID',
    });
    subsidiarySublist.addField({
      id: 'custpage_sub_default',
      type: serverWidget.FieldType.CHECKBOX,
      label: 'Default',
    });

    // ── Tab: Account Mapping ─────────────────────────────────────
    form.addTab({
      id: 'custpage_tab_accounts',
      label: 'Account Mapping',
    });

    var accountSublist = form.addSublist({
      id: 'custpage_account_list',
      type: serverWidget.SublistType.INLINEEDITOR,
      label: 'CorpayOne Category → NetSuite GL Account',
      tab: 'custpage_tab_accounts',
    });

    accountSublist.addField({
      id: 'custpage_acct_corpay_category',
      type: serverWidget.FieldType.TEXT,
      label: 'CorpayOne Category',
    });
    accountSublist.addField({
      id: 'custpage_acct_corpay_code',
      type: serverWidget.FieldType.TEXT,
      label: 'Account Code (optional)',
    });
    accountSublist.addField({
      id: 'custpage_acct_ns_account',
      type: serverWidget.FieldType.SELECT,
      label: 'NetSuite GL Account',
      source: 'account',
    });
    accountSublist.addField({
      id: 'custpage_acct_subsidiary',
      type: serverWidget.FieldType.SELECT,
      label: 'Subsidiary (optional)',
      source: 'subsidiary',
    });
    accountSublist.addField({
      id: 'custpage_acct_default',
      type: serverWidget.FieldType.CHECKBOX,
      label: 'Default',
    });

    // ── Tab: Tax Code Mapping ────────────────────────────────────
    form.addTab({
      id: 'custpage_tab_taxcodes',
      label: 'Tax Code Mapping',
    });

    var taxSublist = form.addSublist({
      id: 'custpage_tax_list',
      type: serverWidget.SublistType.INLINEEDITOR,
      label: 'CorpayOne VAT Rate → NetSuite Tax Code',
      tab: 'custpage_tab_taxcodes',
    });

    taxSublist.addField({
      id: 'custpage_tax_vat_rate',
      type: serverWidget.FieldType.PERCENT,
      label: 'CorpayOne VAT Rate (%)',
    });
    taxSublist.addField({
      id: 'custpage_tax_label',
      type: serverWidget.FieldType.TEXT,
      label: 'Label (e.g. "DK 25% Moms")',
    });
    taxSublist.addField({
      id: 'custpage_tax_ns_code',
      type: serverWidget.FieldType.SELECT,
      label: 'NetSuite Tax Code',
      source: 'salestaxitem',
    });
    taxSublist.addField({
      id: 'custpage_tax_country',
      type: serverWidget.FieldType.TEXT,
      label: 'Country Code (e.g. DK)',
    });
    taxSublist.addField({
      id: 'custpage_tax_subsidiary',
      type: serverWidget.FieldType.SELECT,
      label: 'Subsidiary (optional)',
      source: 'subsidiary',
    });
    taxSublist.addField({
      id: 'custpage_tax_default',
      type: serverWidget.FieldType.CHECKBOX,
      label: 'Default',
    });

    // ── Tab: Bank Account ────────────────────────────────────────
    form.addTab({
      id: 'custpage_tab_bank',
      label: 'Bank Account',
    });

    var bankSublist = form.addSublist({
      id: 'custpage_bank_list',
      type: serverWidget.SublistType.INLINEEDITOR,
      label: 'Payment Bank Account Configuration',
      tab: 'custpage_tab_bank',
    });

    bankSublist.addField({
      id: 'custpage_bank_ns_account',
      type: serverWidget.FieldType.SELECT,
      label: 'NetSuite Bank Account',
      source: 'account',
    });
    bankSublist.addField({
      id: 'custpage_bank_currency',
      type: serverWidget.FieldType.SELECT,
      label: 'Currency',
      source: 'currency',
    });
    bankSublist.addField({
      id: 'custpage_bank_subsidiary',
      type: serverWidget.FieldType.SELECT,
      label: 'Subsidiary (optional)',
      source: 'subsidiary',
    });
    bankSublist.addField({
      id: 'custpage_bank_default',
      type: serverWidget.FieldType.CHECKBOX,
      label: 'Default',
    });

    // ── Tab: Settings ────────────────────────────────────────────
    form.addTab({
      id: 'custpage_tab_settings',
      label: 'Settings',
    });

    var settingsGroup = form.addFieldGroup({
      id: 'custpage_settings_group',
      label: 'Integration Settings',
      tab: 'custpage_tab_settings',
    });

    form.addField({
      id: 'custpage_setting_sync_interval',
      type: serverWidget.FieldType.INTEGER,
      label: 'Sync Interval (minutes)',
      container: 'custpage_settings_group',
    }).defaultValue = '15';

    form.addField({
      id: 'custpage_setting_auto_create_vendors',
      type: serverWidget.FieldType.CHECKBOX,
      label: 'Auto-create Vendors in NetSuite',
      container: 'custpage_settings_group',
    }).defaultValue = 'T';

    form.addField({
      id: 'custpage_setting_upload_attachments',
      type: serverWidget.FieldType.CHECKBOX,
      label: 'Upload Invoice Attachments to File Cabinet',
      container: 'custpage_settings_group',
    }).defaultValue = 'F';

    form.addField({
      id: 'custpage_setting_api_url',
      type: serverWidget.FieldType.URL,
      label: 'Integration API URL',
      container: 'custpage_settings_group',
    }).defaultValue = INTEGRATION_API_URL;

    // ── Load existing configuration from the integration API ─────
    try {
      var response = https.get({
        url: INTEGRATION_API_URL + '/api/config/summary',
      });

      if (response.code === 200) {
        var config = JSON.parse(response.body);
        populateSubsidiaries(subsidiarySublist, config.subsidiaries || []);
        populateAccountMappings(accountSublist, config.accountMappings || []);
        populateTaxCodeMappings(taxSublist, config.taxCodeMappings || []);
        populateBankAccounts(bankSublist, config.bankAccounts || []);
        populateSettings(form, config.settings || {});
      }
    } catch (e) {
      log.audit('CorpayOne Config', 'Could not load existing config: ' + e.message);
    }

    // ── Submit button ────────────────────────────────────────────
    form.addSubmitButton({ label: 'Save Configuration' });

    context.response.writePage(form);
  }

  // ─── POST: Save configuration back to the integration API ────────

  function onRequestPost(context) {
    var request = context.request;

    try {
      // Save subsidiary mappings
      var subCount = request.getLineCount({ group: 'custpage_subsidiary_list' });
      var subsidiaries = [];
      for (var i = 0; i < subCount; i++) {
        var nsId = request.getSublistValue({ group: 'custpage_subsidiary_list', name: 'custpage_sub_ns_id', line: i });
        if (!nsId) continue;
        subsidiaries.push({
          netsuite_subsidiary_id: nsId,
          netsuite_subsidiary_name: getSubsidiaryName(nsId),
          corpayone_entity_id: request.getSublistValue({ group: 'custpage_subsidiary_list', name: 'custpage_sub_corpay_entity', line: i }) || undefined,
          is_default: request.getSublistValue({ group: 'custpage_subsidiary_list', name: 'custpage_sub_default', line: i }) === 'T',
        });
      }

      // Save account mappings
      var acctCount = request.getLineCount({ group: 'custpage_account_list' });
      var accounts = [];
      for (var j = 0; j < acctCount; j++) {
        var category = request.getSublistValue({ group: 'custpage_account_list', name: 'custpage_acct_corpay_category', line: j });
        var nsAcct = request.getSublistValue({ group: 'custpage_account_list', name: 'custpage_acct_ns_account', line: j });
        if (!category || !nsAcct) continue;
        accounts.push({
          corpayone_category: category,
          corpayone_account_code: request.getSublistValue({ group: 'custpage_account_list', name: 'custpage_acct_corpay_code', line: j }) || undefined,
          netsuite_account_id: nsAcct,
          netsuite_account_name: getAccountName(nsAcct),
          subsidiary_id: request.getSublistValue({ group: 'custpage_account_list', name: 'custpage_acct_subsidiary', line: j }) || undefined,
          is_default: request.getSublistValue({ group: 'custpage_account_list', name: 'custpage_acct_default', line: j }) === 'T',
        });
      }

      // Save tax code mappings
      var taxCount = request.getLineCount({ group: 'custpage_tax_list' });
      var taxCodes = [];
      for (var k = 0; k < taxCount; k++) {
        var vatRate = request.getSublistValue({ group: 'custpage_tax_list', name: 'custpage_tax_vat_rate', line: k });
        var nsCode = request.getSublistValue({ group: 'custpage_tax_list', name: 'custpage_tax_ns_code', line: k });
        if (!vatRate || !nsCode) continue;
        taxCodes.push({
          corpayone_vat_rate: parseFloat(vatRate),
          corpayone_label: request.getSublistValue({ group: 'custpage_tax_list', name: 'custpage_tax_label', line: k }) || undefined,
          netsuite_tax_code_id: nsCode,
          netsuite_tax_code_name: getTaxCodeName(nsCode),
          country_code: request.getSublistValue({ group: 'custpage_tax_list', name: 'custpage_tax_country', line: k }) || undefined,
          subsidiary_id: request.getSublistValue({ group: 'custpage_tax_list', name: 'custpage_tax_subsidiary', line: k }) || undefined,
          is_default: request.getSublistValue({ group: 'custpage_tax_list', name: 'custpage_tax_default', line: k }) === 'T',
        });
      }

      // Save bank account config
      var bankCount = request.getLineCount({ group: 'custpage_bank_list' });
      var bankAccounts = [];
      for (var b = 0; b < bankCount; b++) {
        var bankAcct = request.getSublistValue({ group: 'custpage_bank_list', name: 'custpage_bank_ns_account', line: b });
        if (!bankAcct) continue;
        bankAccounts.push({
          netsuite_bank_account_id: bankAcct,
          netsuite_bank_account_name: getAccountName(bankAcct),
          currency: request.getSublistValue({ group: 'custpage_bank_list', name: 'custpage_bank_currency', line: b }) || undefined,
          subsidiary_id: request.getSublistValue({ group: 'custpage_bank_list', name: 'custpage_bank_subsidiary', line: b }) || undefined,
          is_default: request.getSublistValue({ group: 'custpage_bank_list', name: 'custpage_bank_default', line: b }) === 'T',
        });
      }

      // Save settings
      var settings = {
        sync_interval: request.getValue({ fieldId: 'custpage_setting_sync_interval' }) || '15',
        auto_create_vendors: request.getValue({ fieldId: 'custpage_setting_auto_create_vendors' }) === 'T' ? 'true' : 'false',
        upload_attachments: request.getValue({ fieldId: 'custpage_setting_upload_attachments' }) === 'T' ? 'true' : 'false',
        api_url: request.getValue({ fieldId: 'custpage_setting_api_url' }) || INTEGRATION_API_URL,
      };

      var apiUrl = settings.api_url || INTEGRATION_API_URL;

      // Push configuration to integration server
      subsidiaries.forEach(function (sub) {
        https.post({ url: apiUrl + '/api/config/subsidiaries', body: JSON.stringify(sub), headers: { 'Content-Type': 'application/json' } });
      });
      accounts.forEach(function (acct) {
        https.post({ url: apiUrl + '/api/config/account-mappings', body: JSON.stringify(acct), headers: { 'Content-Type': 'application/json' } });
      });
      taxCodes.forEach(function (tc) {
        https.post({ url: apiUrl + '/api/config/tax-code-mappings', body: JSON.stringify(tc), headers: { 'Content-Type': 'application/json' } });
      });
      bankAccounts.forEach(function (ba) {
        https.post({ url: apiUrl + '/api/config/bank-accounts', body: JSON.stringify(ba), headers: { 'Content-Type': 'application/json' } });
      });

      // Save settings
      Object.keys(settings).forEach(function (key) {
        https.put({
          url: apiUrl + '/api/config/settings/' + key,
          body: JSON.stringify({ value: settings[key] }),
          headers: { 'Content-Type': 'application/json' },
        });
      });

      log.audit('CorpayOne Config', 'Configuration saved successfully');

    } catch (e) {
      log.error('CorpayOne Config', 'Failed to save configuration: ' + e.message);
    }

    // Redirect back to the suitelet
    context.response.sendRedirect({
      type: https.RedirectType.SUITELET,
      identifier: runtime.getCurrentScript().id,
      id: runtime.getCurrentScript().deploymentId,
    });
  }

  // ─── Helper: Populate sublists from existing config ──────────────

  function populateSubsidiaries(sublist, data) {
    for (var i = 0; i < data.length; i++) {
      sublist.setSublistValue({ id: 'custpage_sub_ns_id', line: i, value: data[i].netsuite_subsidiary_id || '' });
      sublist.setSublistValue({ id: 'custpage_sub_corpay_entity', line: i, value: data[i].corpayone_entity_id || '' });
      sublist.setSublistValue({ id: 'custpage_sub_default', line: i, value: data[i].is_default ? 'T' : 'F' });
    }
  }

  function populateAccountMappings(sublist, data) {
    for (var i = 0; i < data.length; i++) {
      sublist.setSublistValue({ id: 'custpage_acct_corpay_category', line: i, value: data[i].corpayone_category || '' });
      sublist.setSublistValue({ id: 'custpage_acct_corpay_code', line: i, value: data[i].corpayone_account_code || '' });
      sublist.setSublistValue({ id: 'custpage_acct_ns_account', line: i, value: data[i].netsuite_account_id || '' });
      if (data[i].subsidiary_id) {
        sublist.setSublistValue({ id: 'custpage_acct_subsidiary', line: i, value: data[i].subsidiary_id });
      }
      sublist.setSublistValue({ id: 'custpage_acct_default', line: i, value: data[i].is_default ? 'T' : 'F' });
    }
  }

  function populateTaxCodeMappings(sublist, data) {
    for (var i = 0; i < data.length; i++) {
      sublist.setSublistValue({ id: 'custpage_tax_vat_rate', line: i, value: String(data[i].corpayone_vat_rate || '') });
      sublist.setSublistValue({ id: 'custpage_tax_label', line: i, value: data[i].corpayone_label || '' });
      sublist.setSublistValue({ id: 'custpage_tax_ns_code', line: i, value: data[i].netsuite_tax_code_id || '' });
      sublist.setSublistValue({ id: 'custpage_tax_country', line: i, value: data[i].country_code || '' });
      if (data[i].subsidiary_id) {
        sublist.setSublistValue({ id: 'custpage_tax_subsidiary', line: i, value: data[i].subsidiary_id });
      }
      sublist.setSublistValue({ id: 'custpage_tax_default', line: i, value: data[i].is_default ? 'T' : 'F' });
    }
  }

  function populateBankAccounts(sublist, data) {
    for (var i = 0; i < data.length; i++) {
      sublist.setSublistValue({ id: 'custpage_bank_ns_account', line: i, value: data[i].netsuite_bank_account_id || '' });
      if (data[i].currency) {
        sublist.setSublistValue({ id: 'custpage_bank_currency', line: i, value: data[i].currency });
      }
      if (data[i].subsidiary_id) {
        sublist.setSublistValue({ id: 'custpage_bank_subsidiary', line: i, value: data[i].subsidiary_id });
      }
      sublist.setSublistValue({ id: 'custpage_bank_default', line: i, value: data[i].is_default ? 'T' : 'F' });
    }
  }

  function populateSettings(form, settings) {
    if (settings.sync_interval) {
      form.updateDefaultValues({ custpage_setting_sync_interval: settings.sync_interval });
    }
    if (settings.auto_create_vendors === 'true') {
      form.updateDefaultValues({ custpage_setting_auto_create_vendors: 'T' });
    }
    if (settings.upload_attachments === 'true') {
      form.updateDefaultValues({ custpage_setting_upload_attachments: 'T' });
    }
    if (settings.api_url) {
      form.updateDefaultValues({ custpage_setting_api_url: settings.api_url });
    }
  }

  // ─── Helper: Look up record names ───────────────────────────────

  function getSubsidiaryName(id) {
    try {
      return search.lookupFields({ type: 'subsidiary', id: id, columns: ['name'] }).name;
    } catch (e) { return ''; }
  }

  function getAccountName(id) {
    try {
      return search.lookupFields({ type: 'account', id: id, columns: ['name'] }).name;
    } catch (e) { return ''; }
  }

  function getTaxCodeName(id) {
    try {
      return search.lookupFields({ type: 'salestaxitem', id: id, columns: ['itemid'] }).itemid;
    } catch (e) { return ''; }
  }

  // ─── Entry point ─────────────────────────────────────────────────

  function onRequest(context) {
    if (context.request.method === 'GET') {
      onRequestGet(context);
    } else {
      onRequestPost(context);
    }
  }

  return { onRequest: onRequest };
});
