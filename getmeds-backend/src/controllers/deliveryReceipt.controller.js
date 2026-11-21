'use strict';

const { isDrWorkflowEnabled } = require('../services/workflowFlags');
const { DispatchBatchError } = require('../services/dispatchBatchService');
const drService = require('../services/deliveryReceiptService');

function drAction(run) {
  return async (req, res, next) => {
    if (!isDrWorkflowEnabled()) {
      return res.status(404).json({
        success: false,
        error: { code: 'FEATURE_OFF', message: 'DR workflow is not switched on yet (GETMEDS_DR_WORKFLOW).' }
      });
    }
    try {
      const data = await run(req, res);
      if (data !== undefined) res.json({ success: true, data });
    } catch (err) {
      if (err instanceof DispatchBatchError) {
        return res.status(err.status).json({
          success: false,
          error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }
        });
      }
      next(err);
    }
  };
}

exports.issueOrderDr = drAction((req) =>
  drService.issueSalesOrderDr({
    orderId: req.params.id,
    entityKey: req.body?.entity_key,
    user: req.user,
    doctorName: req.body?.doctor_name,
    terms: req.body?.terms,
    tin: req.body?.tin,
    ltoLicenseNumber: req.body?.lto_license_number,
    notes: req.body?.notes,
    expectedUpdatedAt: req.body?.expected_updated_at || null,
    expectedCateredBy: req.body?.expected_catered_by ?? null
  }));

exports.finalizeZohoInvoice = drAction((req) =>
  drService.finalizeZohoInvoiceForOrder({
    orderId: req.params.id,
    entityKey: req.body?.entity_key,
    siSuffix: req.body?.si_suffix,
    doctorName: req.body?.doctor_name,
    user: req.user,
    expectedUpdatedAt: req.body?.expected_updated_at || null,
    expectedCateredBy: req.body?.expected_catered_by ?? null
  }));

exports.listLedger = drAction((req) =>
  drService.listLedger({
    entityKey: req.query.entity,
    referenceType: req.query.reference_type,
    status: req.query.status,
    fromDate: req.query.from,
    toDate: req.query.to,
    search: req.query.search,
    page: req.query.page,
    limit: req.query.limit
  }));

exports.exportLedger = drAction(async (req, res) => {
  const buffer = await drService.exportLedgerXlsx({
    entityKey: req.query.entity,
    referenceType: req.query.reference_type,
    status: req.query.status,
    fromDate: req.query.from,
    toDate: req.query.to,
    search: req.query.search
  });
  const suffix = req.query.entity ? `-${String(req.query.entity).toUpperCase()}` : '';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="dr-ledger${suffix}.xlsx"`);
  res.send(Buffer.from(buffer));
});

exports.getDr = drAction((req) =>
  drService.getPrintableDr({ drId: req.params.drId }));

exports.issueTransferDr = drAction((req) =>
  drService.issueTransferOrderDr({
    entityKey: req.body?.entity_key,
    externalRef: req.body?.external_ref,
    transferName: req.body?.transfer_name,
    deliveryAddress: req.body?.delivery_address,
    dateIssued: req.body?.date_issued,
    notes: req.body?.notes,
    items: req.body?.items || [],
    user: req.user
  }));

exports.listTransferOrders = drAction((req) =>
  drService.listZohoTransferOrders({
    search: req.query.search || '',
    page: req.query.page || 1,
    perPage: req.query.per_page || 50
  }));

exports.getTransferOrder = drAction((req) =>
  drService.getZohoTransferOrderForDr({
    transferOrderId: req.params.toId
  }));

exports.voidDr = drAction((req) =>
  drService.voidDeliveryReceipt({
    drId: req.params.drId,
    user: req.user,
    reason: req.body?.reason,
    switchToNoSi: Boolean(req.body?.switch_to_no_si),
    expectedUpdatedAt: req.body?.expected_updated_at || null
  }));

exports.recordPrint = drAction((req) =>
  drService.recordDrPrint({
    drId: req.params.drId,
    user: req.user
  }));

exports.shipOrderZoho = drAction((req) =>
  drService.shipInvoicedOrderInZoho({
    orderId: req.params.id,
    entityKey: req.body?.entity_key || null,
    deliveryMethod: req.body?.delivery_method,
    trackingNumber: req.body?.tracking_number,
    requireTracking: true,
    user: req.user,
    expectedUpdatedAt: req.body?.expected_updated_at || null,
    expectedCateredBy: req.body?.expected_catered_by ?? null
  }));
