import { Router, type Request, type Response } from 'express';
import {
  getAllAccountMappings,
  upsertAccountMapping,
  deleteAccountMapping,
  getAllTaxCodeMappings,
  upsertTaxCodeMapping,
  deleteTaxCodeMapping,
  getAllBankAccountConfigs,
  upsertBankAccountConfig,
  deleteBankAccountConfig,
  getAllSubsidiaryConfigs,
  upsertSubsidiaryConfig,
  deleteSubsidiaryConfig,
  getAllSettings,
  setSetting,
} from '../database/mapping-db';

/**
 * Configuration API routes for the CorpayOne-NetSuite integration.
 *
 * These endpoints let admins (or the SuiteScript dashboard) manage
 * the mapping configuration: which CorpayOne accounts map to which
 * NetSuite GL accounts, tax code mappings, bank account selection,
 * and subsidiary assignment.
 */
export function createConfigRouter(): Router {
  const router = Router();

  // --- Account Mappings ---

  router.get('/account-mappings', (_req: Request, res: Response) => {
    res.json(getAllAccountMappings());
  });

  router.post('/account-mappings', (req: Request, res: Response) => {
    const mapping = upsertAccountMapping(req.body);
    res.status(201).json(mapping);
  });

  router.delete('/account-mappings/:id', (req: Request, res: Response) => {
    deleteAccountMapping(parseInt(req.params.id, 10));
    res.status(204).end();
  });

  // --- Tax Code Mappings ---

  router.get('/tax-code-mappings', (_req: Request, res: Response) => {
    res.json(getAllTaxCodeMappings());
  });

  router.post('/tax-code-mappings', (req: Request, res: Response) => {
    const mapping = upsertTaxCodeMapping(req.body);
    res.status(201).json(mapping);
  });

  router.delete('/tax-code-mappings/:id', (req: Request, res: Response) => {
    deleteTaxCodeMapping(parseInt(req.params.id, 10));
    res.status(204).end();
  });

  // --- Bank Account Config ---

  router.get('/bank-accounts', (_req: Request, res: Response) => {
    res.json(getAllBankAccountConfigs());
  });

  router.post('/bank-accounts', (req: Request, res: Response) => {
    const cfg = upsertBankAccountConfig(req.body);
    res.status(201).json(cfg);
  });

  router.delete('/bank-accounts/:id', (req: Request, res: Response) => {
    deleteBankAccountConfig(parseInt(req.params.id, 10));
    res.status(204).end();
  });

  // --- Subsidiary Config ---

  router.get('/subsidiaries', (_req: Request, res: Response) => {
    res.json(getAllSubsidiaryConfigs());
  });

  router.post('/subsidiaries', (req: Request, res: Response) => {
    const cfg = upsertSubsidiaryConfig(req.body);
    res.status(201).json(cfg);
  });

  router.delete('/subsidiaries/:id', (req: Request, res: Response) => {
    deleteSubsidiaryConfig(parseInt(req.params.id, 10));
    res.status(204).end();
  });

  // --- Integration Settings ---

  router.get('/settings', (_req: Request, res: Response) => {
    res.json(getAllSettings());
  });

  router.put('/settings/:key', (req: Request, res: Response) => {
    const { value } = req.body;
    setSetting(req.params.key, value);
    res.json({ key: req.params.key, value });
  });

  // --- Full configuration summary ---

  router.get('/summary', (_req: Request, res: Response) => {
    res.json({
      accountMappings: getAllAccountMappings(),
      taxCodeMappings: getAllTaxCodeMappings(),
      bankAccounts: getAllBankAccountConfigs(),
      subsidiaries: getAllSubsidiaryConfigs(),
      settings: getAllSettings(),
    });
  });

  return router;
}
