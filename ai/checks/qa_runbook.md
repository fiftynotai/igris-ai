# QA Runbook Template — Opaala Admin App v3

Use this template to verify any feature or bug fix before marking as "Done".

---

## Pre-Test Setup

### Environment
- [ ] Test device: [Android/iOS version, device model]
- [ ] Build version: [e.g., v2.6.0+215]
- [ ] Build source: [Firebase App Distribution link or local build]
- [ ] API environment: [Staging or Production]

### Test Account
- **Username:** [credentials]
- **Password:** [credentials]
- **Venue:** [specific venue/zone for testing]

### Dependencies
- [ ] Backend API available
- [ ] Test data seeded
- [ ] External services (Firebase, sockets) operational

---

## Feature-Specific Test Cases

### Test Case 1: [Feature Name - Happy Path]

**Objective:** Verify [what this test validates]

**Preconditions:**
- [e.g., User is logged in]
- [e.g., Venue X is selected]

**Steps:**
1. [Action 1]
2. [Action 2]
3. [Action 3]

**Expected Result:**
- [Outcome 1]
- [Outcome 2]

**Actual Result:** [Fill during test]
**Status:** [ ] Pass / [ ] Fail / [ ] Blocked
**Evidence:** [Screenshot or video link]

---

## Regression Testing

### Critical Flows (Always Test)

#### 1. Login Flow
- [ ] User can log in with valid credentials
- [ ] Error shown for invalid credentials
- [ ] Session persists after app restart

#### 2. Venue Selection
- [ ] Venue picker displays all venues
- [ ] Zone picker displays zones
- [ ] Selected venue persists

#### 3. Events Module
- [ ] Events list loads correctly
- [ ] Real-time updates via socket work
- [ ] Event details screen opens
- [ ] Confirm event action works

#### 4. Printer Configuration
- [ ] Can add/edit/delete printers
- [ ] Role-based routing works (KOT → Kitchen, Bill → Front Desk)

#### 5. KDS Module
- [ ] Kitchen mode displays orders
- [ ] Front Desk mode displays orders
- [ ] Order status updates work

---

## Performance Testing

### Metrics to Check
- [ ] App launch time: < 3 seconds
- [ ] Events list load time: < 2 seconds
- [ ] Memory usage: < 300 MB (after 10 min)

### Stress Tests
- [ ] App handles 100+ events without crash
- [ ] Socket reconnects after network interruption

---

## Error Handling

### Network Errors
- [ ] Offline mode shows graceful error
- [ ] Slow network shows loader
- [ ] 401 triggers token refresh
- [ ] 500 shows user-friendly error

### UI Errors
- [ ] Empty states show proper message
- [ ] Loading states show spinner
- [ ] Error states show retry button

---

## Device Compatibility

### Android
- [ ] Android 8.0 (API 26) - minimum
- [ ] Android 13 (API 33) - latest
- [ ] Small screen (5.5") works
- [ ] Large screen (10") works

### iOS
- [ ] iOS 13 - minimum
- [ ] iOS 17 - latest
- [ ] iPhone SE works
- [ ] iPad works

---

## QA Sign-Off

**Tested By:** [Name]
**Date:** [Date]
**Build Version:** [Version]

**Overall Status:** [ ] Approved / [ ] Approved with Caveats / [ ] Rejected

**Caveats/Known Issues:**
- [Issue 1]

**Sign-Off Notes:**
[Comments]

---

**Last Updated:** 2025-10-13
