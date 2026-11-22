const mongoose = require('mongoose')

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, required: true, enum: ['owner', 'manager', 'agent', 'driver', 'mechanic'] },
  branch: { type: String, required: true, trim: true },
  driverProfile: {
    languages: { type: [String], default: undefined },
    licenceClass: { type: String, trim: true },
    licenceExpiresAt: { type: Date },
    psvExpiresAt: { type: Date },
    rating: { type: Number, min: 0, max: 5, default: 0 },
    status: { type: String, enum: ['available', 'off_duty'], default: 'available' },
    assignmentRevision: { type: Number, default: 0, select: false },
    lastAssignedAt: { type: Date },
  },
  active: { type: Boolean, default: true },
  bootstrapOwner: { type: Boolean, default: false, select: false },
  lastLoginAt: { type: Date },
}, { timestamps: true })

const refreshSessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  refreshTokenHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
}, { timestamps: true })

const staffInvitationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, required: true, trim: true },
  role: { type: String, required: true, enum: ['owner', 'manager', 'agent', 'driver', 'mechanic'] },
  branch: { type: String, required: true, trim: true },
  driverProfile: {
    languages: { type: [String], default: undefined },
    licenceClass: { type: String, trim: true },
    licenceExpiresAt: { type: Date },
    psvExpiresAt: { type: Date },
    rating: { type: Number, min: 0, max: 5, default: 0 },
    status: { type: String, enum: ['available', 'off_duty'], default: 'available' },
  },
  tokenHash: { type: String, required: true, select: false },
  createdById: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  expiresAt: { type: Date, required: true },
  acceptedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
}, { timestamps: true })

const passwordResetSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  tokenHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
}, { timestamps: true })

const vehicleSchema = new mongoose.Schema({
  make: { type: String, required: true, trim: true, maxlength: 100 },
  model: { type: String, required: true, trim: true, maxlength: 100 },
  category: { type: String, trim: true, maxlength: 50 },
  year: { type: Number, required: true, min: 1900 },
  registration: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
  registrationKey: { type: String, required: true, select: false },
  seats: { type: Number, required: true, min: 1 },
  transmission: { type: String, required: true, enum: ['automatic', 'manual'] },
  ratePerDay: { type: Number, required: true, min: 0 },
  status: { type: String, required: true, enum: ['available', 'maintenance', 'inactive'], default: 'available' },
  availabilityRevision: { type: Number, required: true, default: 0, select: false },
}, { timestamps: true })

const maintenanceWindowSchema = new mongoose.Schema({
  vehicleId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'Vehicle' },
  startAt: { type: Date, required: true },
  endAt: { type: Date, required: true },
  reason: { type: String, required: true, trim: true, maxlength: 1000 },
  createdById: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
}, { timestamps: true })

const bookingSchema = new mongoose.Schema({
  reference: { type: String, required: true },
  vehicleId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'Vehicle' },
  customerId: { type: String, required: true },
  customerName: { type: String, required: true },
  customerPhone: { type: String, required: true },
  customerEmail: { type: String, required: true },
  customerIdNumber: { type: String, required: true },
  pickupLocation: { type: String, trim: true, maxlength: 300 },
  status: { type: String, required: true, enum: ['reserved', 'confirmed', 'checked_out', 'overdue', 'completed', 'cancelled', 'expired'], default: 'reserved' },
  pendingApproval: { type: Boolean, required: true },
  pickupAt: { type: Date, required: true },
  returnAt: { type: Date, required: true },
  totalKes: { type: Number, required: true, min: 0 },
  mode: { type: String, required: true, enum: ['self_drive', 'chauffeur'] },
  paymentMethod: { type: String, required: true, enum: ['mpesa_online', 'mpesa_manual', 'cash', 'bank', 'corporate'] },
  holdExpiresAt: { type: Date, required: true },
  createdById: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  driverTripStatus: { type: String, enum: ['en_route_to_pickup', 'customer_onboard', 'trip_completed'] },
  accruedLateFeeKes: { type: Number, min: 0, default: 0 },
  inspections: [{
    id: { type: String, required: true },
    type: { type: String, required: true, enum: ['check_out', 'check_in'] },
    odometer: { type: Number, required: true, min: 0 },
    fuelLevel: { type: String, required: true, enum: ['empty', 'quarter', 'half', 'three_quarters', 'full'] },
    createdAt: { type: Date, required: true },
    notes: { type: String, maxlength: 1000 },
    photos: [{
      id: { type: String, required: true },
      url: { type: String, required: true },
      storageKey: { type: String, required: true, select: false },
      mimeType: { type: String, required: true, enum: ['image/jpeg', 'image/png', 'image/webp'] },
      sizeBytes: { type: Number, required: true, min: 1 },
      sha256: { type: String, required: true },
    }],
    signatureConfirmed: { type: Boolean, required: true },
    criticalDefect: { type: Boolean, required: true },
    settlement: {
      graceHours: Number,
      lateHours: Number,
      lateFeeKes: Number,
      odometerDifferenceKm: Number,
      includedMileageKm: Number,
      excessMileageKm: Number,
      excessMileageRateKes: Number,
      excessMileageChargeKes: Number,
      totalKes: Number,
    },
  }],
  pendingInspectionPhotos: [{
    id: { type: String, required: true },
    type: { type: String, required: true, enum: ['check_out', 'check_in'] },
    url: { type: String, required: true },
    storageKey: { type: String, required: true, select: false },
    mimeType: { type: String, required: true, enum: ['image/jpeg', 'image/png', 'image/webp'] },
    sizeBytes: { type: Number, required: true, min: 1 },
    sha256: { type: String, required: true },
  }],
  pricingSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  licence: {
    storageKey: { type: String, select: false },
    mimeType: { type: String, enum: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], select: false },
    sizeBytes: { type: Number, min: 1, select: false },
    sha256: { type: String, select: false },
    uploadedAt: { type: Date, select: false },
    deleteAfter: { type: Date, select: false },
  },
  payments: [{
    id: { type: String, required: true },
    method: { type: String, required: true, enum: ['mpesa_online', 'mpesa_manual', 'cash', 'bank', 'corporate'] },
    amountKes: { type: Number, required: true, min: 0 },
    status: { type: String, required: true, enum: ['pending', 'paid', 'failed', 'refund_pending', 'refunded'] },
    reference: { type: String, required: true },
    createdAt: { type: Date, required: true },
  }],
  events: [{
    id: { type: String, required: true },
    type: { type: String, required: true },
    actor: { type: String, required: true },
    note: { type: String, required: true },
    createdAt: { type: Date, required: true },
  }],
  idempotencyKey: { type: String, select: false },
  idempotencyRequestHash: { type: String, select: false },
}, { timestamps: true })

const guestAccessSchema = new mongoose.Schema({
  bookingId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'Booking' },
  reference: { type: String, required: true },
  exchangeTokenHash: { type: String, select: false },
  exchangeExpiresAt: { type: Date },
  sessionTokenHash: { type: String, select: false },
  expiresAt: { type: Date, required: true },
  exchangedAt: { type: Date },
  revokedAt: { type: Date },
}, { timestamps: true })

const paymentSchema = new mongoose.Schema({
  paymentId: { type: String, required: true },
  bookingId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'Booking' },
  amountKes: { type: Number, required: true, min: 1 },
  requestedAmountKes: { type: Number, required: true, min: 1 },
  phone: { type: String, required: true, select: false },
  status: { type: String, required: true, enum: ['pending', 'paid', 'failed', 'refund_pending', 'refunded'], default: 'pending' },
  externalReference: { type: String, required: true },
  providerReference: { type: String },
  checkoutRequestId: { type: String },
  merchantRequestId: { type: String },
  receipt: { type: String },
  idempotencyKey: { type: String, select: false },
  idempotencyRequestHash: { type: String, select: false },
  createdAt: { type: Date, required: true, default: Date.now },
  settledAt: { type: Date },
}, { timestamps: true })

const paymentEventSchema = new mongoose.Schema({
  providerEventId: { type: String, required: true },
  paymentId: { type: String, required: true },
  payloadHash: { type: String, required: true },
  processedAt: { type: Date, required: true, default: Date.now },
}, { timestamps: true })

const refundSchema = new mongoose.Schema({
  refundId: { type: String, required: true },
  bookingId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'Booking' },
  paymentId: { type: String, required: true },
  amountKes: { type: Number, required: true, min: 1 },
  status: { type: String, required: true, enum: ['pending', 'refunded', 'failed'], default: 'pending' },
  reason: { type: String, required: true, trim: true, maxlength: 1000 },
  providerReference: { type: String },
  createdById: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  processedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  idempotencyKey: { type: String, select: false },
  idempotencyRequestHash: { type: String, select: false },
  settledAt: { type: Date },
}, { timestamps: true })

const mechanicSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  phone: { type: String, required: true, trim: true, maxlength: 30 },
  whatsapp: { type: String, required: true, trim: true, maxlength: 30 },
  county: { type: String, required: true, trim: true, maxlength: 120 },
  town: { type: String, required: true, trim: true, maxlength: 120 },
  type: { type: String, required: true, enum: ['in_house', 'partner_garage', 'towing'] },
  specialties: { type: [String], required: true, enum: ['flat_tyre', 'battery', 'overheating', 'accident', 'strange_noise'] },
  callOutRateKes: { type: Number, required: true, min: 0 },
  location: {
    type: { type: String, enum: ['Point'], required: true },
    coordinates: { type: [Number], required: true, validate: (value) => value.length === 2 },
  },
  active: { type: Boolean, default: true },
}, { timestamps: true })

const incidentSchema = new mongoose.Schema({
  reference: { type: String, required: true },
  status: { type: String, required: true, enum: ['open', 'awaiting_replacement', 'dispatched', 'resolved'], default: 'open' },
  description: { type: String, required: true, trim: true, maxlength: 3000 },
  category: { type: String, required: true, enum: ['flat_tyre', 'battery', 'overheating', 'accident', 'strange_noise'] },
  location: {
    type: { type: String, enum: ['Point'], required: true },
    coordinates: { type: [Number], required: true, validate: (value) => value.length === 2 },
  },
  locationText: { type: String, required: true, trim: true, maxlength: 300 },
  vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
  immobilising: { type: Boolean, required: true },
  photos: [{
    id: { type: String, required: true },
    url: { type: String, required: true },
    storageKey: { type: String, required: true, select: false },
    mimeType: { type: String, required: true, enum: ['image/jpeg', 'image/png', 'image/webp'] },
    sizeBytes: { type: Number, required: true, min: 1 },
    sha256: { type: String, required: true },
  }],
  source: { type: String, required: true, enum: ['driver', 'customer', 'desk'] },
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  dispatch: {
    type: { type: String, enum: ['closest_partner', 'in_house_rescue', 'replacement_vehicle'] },
    mechanicId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mechanic' },
    vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
    createdAt: Date,
  },
  resolution: { type: String, trim: true, maxlength: 2000 },
  events: [{
    id: { type: String, required: true },
    type: { type: String, required: true },
    actor: { type: String, required: true },
    note: { type: String, required: true },
    createdAt: { type: Date, required: true },
  }],
}, { timestamps: true })

const auditEntrySchema = new mongoose.Schema({
  actorId: { type: String },
  actor: { type: String, required: true, maxlength: 160 },
  action: { type: String, required: true, maxlength: 200 },
  entity: { type: String, required: true, maxlength: 160 },
  requestId: { type: String, maxlength: 120 },
  before: { type: mongoose.Schema.Types.Mixed },
  after: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, required: true, default: Date.now },
}, { versionKey: false })

const model = (name, schema) => mongoose.models[name] || mongoose.model(name, schema)

module.exports = {
  User: model('User', userSchema),
  RefreshSession: model('RefreshSession', refreshSessionSchema),
  StaffInvitation: model('StaffInvitation', staffInvitationSchema),
  PasswordReset: model('PasswordReset', passwordResetSchema),
  Vehicle: model('Vehicle', vehicleSchema),
  MaintenanceWindow: model('MaintenanceWindow', maintenanceWindowSchema),
  Booking: model('Booking', bookingSchema),
  GuestAccess: model('GuestAccess', guestAccessSchema),
  Payment: model('Payment', paymentSchema),
  PaymentEvent: model('PaymentEvent', paymentEventSchema),
  Refund: model('Refund', refundSchema),
  Mechanic: model('Mechanic', mechanicSchema),
  Incident: model('Incident', incidentSchema),
  AuditEntry: model('AuditEntry', auditEntrySchema),
}
