/**
 * Response fixtures shaped after the response schemas of the KeyCRM OpenAPI
 * document. All identifiers, names and numbers are made up.
 */

export const IDS = {
  order: 1501,
  buyer: 310,
  status: 4,
  source: 2,
  manager: 7,
  pipeline: 3,
  pipelineStatus: 12,
  card: 880,
  contact: 4410,
} as const;

const manager = {
  id: IDS.manager,
  first_name: 'Олег',
  last_name: 'Тестовий',
  full_name: 'Олег Тестовий',
  username: 'oleg',
  email: 'oleg@example.com',
  phone: '+380441234567',
  role_id: 1,
  status: 'active',
  created_at: '2026-01-10 09:00:00',
  updated_at: '2026-09-01 09:00:00',
  last_logged_at: '2026-10-08 06:00:00',
};

export const order = {
  id: IDS.order,
  parent_id: null,
  source_uuid: 'SHOP-1024',
  source_id: IDS.source,
  status_id: IDS.status,
  status_group_id: 2,
  grand_total: 1350.5,
  promocode: null,
  total_discount: 50,
  margin_sum: 400,
  expenses_sum: 0,
  shipping_price: 90,
  wrap_price: 0,
  taxes: 0,
  manager_comment: 'Передзвонити після 14:00',
  buyer_comment: '',
  gift_message: null,
  is_gift: false,
  payment_status: 'paid',
  last_synced_at: null,
  created_at: '2026-10-07 08:15:00',
  ordered_at: '2026-10-07 08:14:30',
  updated_at: '2026-10-07 10:00:00',
  closed_at: null,
};

export const orderWithIncludes = {
  ...order,
  buyer: { id: IDS.buyer, full_name: 'Ірина Тестова', email: 'iryna@example.com', phone: '+380501234567', company_id: null, manager_id: IDS.manager },
  status: { id: IDS.status, name: 'Відправлено', alias: 'sent', is_active: true, group_id: 2, is_closing_order: false, is_reserved: false },
  manager,
  products: [
    {
      name: 'Чашка керамічна',
      sku: 'CUP-01',
      price: 450.5,
      price_sold: 420.5,
      purchased_price: 200,
      discount_percent: 0,
      discount_amount: 30,
      total_discount: 30,
      quantity: 3,
      unit_type: null,
      upsale: false,
      comment: null,
      product_status_id: 1,
      picture: 'https://example.com/cup.png',
      properties: [],
      shipment_type: 'warehouse',
      offer: { id: 55, product_id: 5, sku: 'CUP-01' },
    },
  ],
  payments: [
    {
      id: 900,
      destination_id: IDS.order,
      payment_method_id: 1,
      amount: 1350.5,
      actual_currency: 'UAH',
      transaction_uuid: null,
      description: null,
      status: 'paid',
      payment_date: '2026-10-07 08:20:00',
      created_at: '2026-10-07 08:20:00',
      updated_at: '2026-10-07 08:20:00',
    },
  ],
  shipping: {
    delivery_service_id: 1,
    tracking_code: '20450000000000',
    shipping_status: 'sent',
    shipping_address_city: 'Київ',
    shipping_address_country: 'Ukraine',
    shipping_address_country_code: 'UA',
    shipping_address_region: null,
    shipping_address_zip: null,
    shipping_secondary_line: null,
    shipping_receive_point: 'Відділення №1',
    recipient_full_name: 'Ірина Тестова',
    recipient_phone: '+380501234567',
    shipping_date_actual: '2026-10-07',
  },
  tags: [{ id: 3, name: 'VIP', alias: 'vip', color: '#ff0000', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' }],
};

export const orderStatus = {
  id: IDS.status,
  name: 'Відправлено',
  alias: 'sent',
  is_active: true,
  group_id: 2,
  is_closing_order: false,
  is_reserved: true,
  expiration_period: null,
  created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-01 00:00:00',
  deleted_at: null,
};

export const source = {
  id: IDS.source,
  name: 'Інтернет-магазин',
  alias: 'shop',
  driver: 'opencart',
  source_uuid: null,
  source_name: null,
  currency_code: 'UAH',
  created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-01 00:00:00',
};

export const buyer = {
  id: IDS.buyer,
  full_name: 'Ірина Тестова',
  birthday: null,
  email: ['iryna@example.com'],
  phone: ['+380501234567'],
  note: 'Постійна клієнтка',
  created_at: '2026-03-01 12:00:00',
  updated_at: '2026-10-07 08:15:00',
};

export const buyerWithIncludes = {
  ...buyer,
  company: { id: 20, name: 'ТОВ «Приклад»', full_name: null, address: null, banking_details: 'UA000000000000000000000000000', note: null },
  manager,
  shipping: [{ address: 'вул. Прикладна, 1', city: 'Київ', region: null, zip_code: '01001', country: 'Ukraine', recipient_full_name: null, recipient_phone: null }],
};

export const pipeline = { id: IDS.pipeline, name: 'Заявки із сайту', target_type: null, target_id: null, use_payments: false, lead_type: 'lead' };

export const pipelineStatus = {
  id: IDS.pipelineStatus,
  pipeline_id: IDS.pipeline,
  title: 'Нова заявка',
  alias: 'new',
  color: '#00aaff',
  is_final: false,
  leads_count: 5,
};

export const card = {
  id: IDS.card,
  contact_id: IDS.contact,
  source_id: IDS.source,
  manager_id: IDS.manager,
  status_id: IDS.pipelineStatus,
  title: 'Заявка: консультація',
  manager_comment: 'Просить передзвонити зранку',
  is_finished: false,
  status_changed_at: '2026-10-08 07:00:00',
  communicate_at: '2026-10-09 07:00:00',
  created_at: '2026-10-08 07:00:00',
  updated_at: '2026-10-08 07:00:00',
};

export const cardWithIncludes = {
  ...card,
  target_id: null,
  target_type: null,
  utm_source: 'google',
  utm_medium: 'cpc',
  utm_campaign: null,
  utm_term: null,
  utm_content: null,
  contact: {
    id: IDS.contact,
    full_name: 'Ірина Тестова',
    email: 'iryna@example.com',
    phone: '+380501234567',
    picture: 'https://example.com/p.png',
    additional_details: [],
    client_id: IDS.buyer,
    social_name: null,
    social_id: null,
    created_at: '2026-10-08 07:00:00',
    updated_at: '2026-10-08 07:00:00',
    client: { id: IDS.buyer, full_name: 'Ірина Тестова', phone: '+380501234567', orders_sum: '1350.50', orders_count: 1 },
  },
  status: { id: IDS.pipelineStatus, name: 'Нова заявка', alias: 'new', is_active: true, pipeline_id: IDS.pipeline },
  manager,
};

export const user = manager;
