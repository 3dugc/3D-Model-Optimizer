import { parseBoolean, parseNumber } from './parsers';
import type { InvoiceConfig } from './types';

export function parseInvoiceConfig(): InvoiceConfig {
  return {
    enabled: parseBoolean(process.env.INVOICE_ENABLED || process.env.WECHAT_FAPIAO_ENABLED, false),
    provider: process.env.INVOICE_PROVIDER === 'wechat_fapiao' ? 'wechat_fapiao' : 'manual',
    storePath: process.env.INVOICE_STORE_PATH || 'data/cloud/invoices.json',
    itemName: process.env.INVOICE_ITEM_NAME || process.env.WECHAT_FAPIAO_GOODS_NAME || '3D模型优化服务',
    subMchId: process.env.WECHAT_FAPIAO_SUB_MCH_ID || process.env.WECHAT_PAY_SUB_MCH_ID,
    taxCode: process.env.WECHAT_FAPIAO_TAX_CODE,
    goodsCategory: process.env.WECHAT_FAPIAO_GOODS_CATEGORY,
    taxRateBps: process.env.WECHAT_FAPIAO_TAX_RATE_BPS
      ? Math.max(0, parseNumber(process.env.WECHAT_FAPIAO_TAX_RATE_BPS, 600))
      : undefined,
    remark: process.env.INVOICE_REMARK || process.env.WECHAT_FAPIAO_REMARK,
  };
}
