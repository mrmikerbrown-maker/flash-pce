/**
 * FLASH PCE NOWCAST  (Google Apps Script)
 * ======================================
 * Chicago Fed "Flash PCE" method (Barlevy, Hobijn, Pennington & Royal, Chicago Fed Letter 529, Sep 2026):
 *   1. Work at the most detailed level BEA publishes: 221 PCE lines (NIPA Tables 2.4.4U / 2.4.5U).
 *   2. Each line's price change for the target month comes from the CPI or PPI series BEA itself uses
 *      (or the nearest one). Lines BEA prices itself (nonprofits, imputed bank services, foreign
 *      travel, life insurance...) are forecast from their own recent history.
 *   3. For every line the script tries several versions (CPI SA, CPI NSA, with/without a
 *      calendar-month correction for BEA's own seasonal adjustment, own-history averages) and uses the
 *      one with the smallest error against BEA over the previous 36 months. Out of sample, no hindsight.
 *   4. A line whose source is not out yet (e.g. PPI day hasn't happened) automatically uses its next
 *      best version. A BLS gap is filled with the average of its BEA parent category.
 *   5. Lines are combined with BEA's Fisher formula using last month's actual BEA spending shares.
 *   No calibration regression: the aggregation is BEA's own formula.
 *
 * SETUP
 *   Extensions > Apps Script, paste this whole file (replace everything), Save.
 *   Project Settings > Script Properties, add three properties:
 *       FRED_API_KEY  (not used by this file, keep it if your old script needs it)
 *       BEA_API_KEY   = your BEA key
 *       BLS_API_KEY   = your BLS key
 *   Reload the sheet, then menu "Flash PCE" > "Refresh". Takes about 30-60 seconds.
 *
 * Tabs written: "Flash PCE" (dashboard), "Flash PCE lines" (all 221 lines), "Flash PCE backtest".
 */

var BACK_YEARS   = 10;   // history pulled (selection window + 5y seasonal correction + 24m backtest)
var SEL_WINDOW   = 36;   // months used to pick each line's best method
var WEDGE_YEARS  = 5;    // years used for the calendar-month correction
var BACKTEST_N   = 24;   // months shown in the backtest tab
// Months left out when scoring methods: COVID lockdown, and the Oct/Nov 2025 shutdown (no CPI).
var SKIP = ['2020-03', '2020-04', '2020-05', '2020-06', '2025-10', '2025-11'];

// [BEA line, sign (-1 = "Less:" line), description, sources, core (1/0), group, ancestors (nearest first)]
// sources: options separated by ';'. C:xxx = CPI item (CUSR0000xxx / CUUR0000xxx), P:id = PPI or
// other BLS id, BEA = forecast from the line's own history. Several ids joined by '|' are averaged.
var LEAVES = [
  [7, 1, 'New domestic autos', 'C:SS45011;BEA', 1, 'Core goods', [6,5,4,3,2]],
  [8, 1, 'New foreign autos', 'C:SS45011;BEA', 1, 'Core goods', [6,5,4,3,2]],
  [10, 1, 'New domestic light trucks', 'C:SS45021;BEA', 1, 'Core goods', [9,5,4,3,2]],
  [11, 1, 'New foreign light trucks', 'C:SS45021;BEA', 1, 'Core goods', [9,5,4,3,2]],
  [14, 1, 'Net transactions in used autos', 'C:SETA02;BEA', 1, 'Core goods', [13,12,4,3,2]],
  [15, 1, 'Used auto margin', 'C:SETA02;BEA', 1, 'Core goods', [13,12,4,3,2]],
  [16, 1, 'Employee reimbursement', 'C:SETA02;BEA', 1, 'Core goods', [13,12,4,3,2]],
  [18, 1, 'Net transactions in used trucks', 'C:SETA02;BEA', 1, 'Core goods', [17,12,4,3,2]],
  [19, 1, 'Used truck margin', 'C:SETA02;BEA', 1, 'Core goods', [17,12,4,3,2]],
  [21, 1, 'Tires', 'C:SETC01;BEA', 1, 'Core goods', [20,4,3,2]],
  [22, 1, 'Accessories and parts', 'C:SETC02;BEA', 1, 'Core goods', [20,4,3,2]],
  [25, 1, 'Furniture', 'C:SEHJ;BEA', 1, 'Core goods', [24,23,3,2]],
  [26, 1, 'Clocks, lamps, lighting fixtures, and other household decorative items', 'C:SEHL01;BEA', 1, 'Core goods', [24,23,3,2]],
  [27, 1, 'Carpets and other floor coverings', 'C:SEHH01;BEA', 1, 'Core goods', [24,23,3,2]],
  [28, 1, 'Window coverings', 'C:SEHH02;BEA', 1, 'Core goods', [24,23,3,2]],
  [30, 1, 'Major household appliances', 'C:SEHK01;BEA', 1, 'Core goods', [29,23,3,2]],
  [31, 1, 'Small electric household appliances', 'C:SEHK02;BEA', 1, 'Core goods', [29,23,3,2]],
  [33, 1, 'Dishes and flatware', 'C:SEHL03;BEA', 1, 'Core goods', [32,23,3,2]],
  [34, 1, 'Nonelectric cookware and tableware', 'C:SEHL04;BEA', 1, 'Core goods', [32,23,3,2]],
  [36, 1, 'Tools, hardware, and supplies', 'C:SEHM01;BEA', 1, 'Core goods', [35,23,3,2]],
  [37, 1, 'Outdoor equipment and supplies', 'C:SEHM02;BEA', 1, 'Core goods', [35,23,3,2]],
  [41, 1, 'Televisions', 'C:SERA01;BEA', 1, 'Core goods', [40,39,38,3,2]],
  [42, 1, 'Other video equipment', 'C:SERA03;BEA', 1, 'Core goods', [40,39,38,3,2]],
  [43, 1, 'Audio equipment', 'C:SERA05;BEA', 1, 'Core goods', [40,39,38,3,2]],
  [45, 1, 'Audio discs, tapes, vinyl, and permanent digital downloads', 'C:SERA06;BEA', 1, 'Core goods', [44,40,39,38,3,2]],
  [46, 1, 'Video discs, tapes, and permanent digital downloads', 'C:SERA04;BEA', 1, 'Core goods', [44,40,39,38,3,2]],
  [47, 1, 'Photographic equipment', 'C:SERD01;BEA', 1, 'Core goods', [39,38,3,2]],
  [49, 1, 'Personal computers/tablets and peripheral equipment', 'C:SEEE01;BEA', 1, 'Core goods', [48,39,38,3,2]],
  [50, 1, 'Computer software and accessories', 'C:SEEE02;C:SEEE02|P:PCU513210513210;BEA', 1, 'Core goods', [48,39,38,3,2]],
  [51, 1, 'Calculators, typewriters, and other information processing equipment', 'C:SEEE04;BEA', 1, 'Core goods', [48,39,38,3,2]],
  [52, 1, 'Sporting equipment, supplies, guns, and ammunition (part of 80)', 'C:SERC02;BEA', 1, 'Core goods', [38,3,2]],
  [54, 1, 'Motorcycles', 'C:SERC01;BEA', 1, 'Core goods', [53,38,3,2]],
  [55, 1, 'Bicycles and accessories', 'C:SERC01;BEA', 1, 'Core goods', [53,38,3,2]],
  [57, 1, 'Pleasure boats', 'C:SERC01;BEA', 1, 'Core goods', [56,53,38,3,2]],
  [58, 1, 'Pleasure aircraft', 'C:SERC01;BEA', 1, 'Core goods', [56,53,38,3,2]],
  [59, 1, 'Other recreational vehicles', 'C:SERC01;BEA', 1, 'Core goods', [56,53,38,3,2]],
  [60, 1, 'Recreational books (part of 90)', 'C:SERG02;BEA', 1, 'Core goods', [38,3,2]],
  [61, 1, 'Musical instruments (part of 80)', 'C:SERE03;BEA', 1, 'Core goods', [38,3,2]],
  [64, 1, 'Jewelry', 'C:SEAG02;BEA', 1, 'Core goods', [63,62,3,2]],
  [65, 1, 'Watches', 'C:SEAG01;BEA', 1, 'Core goods', [63,62,3,2]],
  [67, 1, 'Therapeutic medical equipment', 'C:SEMG;BEA', 1, 'Core goods', [66,62,3,2]],
  [68, 1, 'Corrective eyeglasses and contact lenses', 'C:SEMC03;BEA', 1, 'Core goods', [66,62,3,2]],
  [69, 1, 'Educational books (96)', 'C:SEEA;BEA', 1, 'Core goods', [62,3,2]],
  [70, 1, 'Luggage and similar personal items (part of 119)', 'C:SEGE;BEA', 1, 'Core goods', [62,3,2]],
  [71, 1, 'Telephone and related communication equipment', 'C:SEEE04;BEA', 1, 'Core goods', [62,3,2]],
  [77, 1, 'Cereals', 'C:SEFA;BEA', 0, 'Food', [76,75,74,73,72,2]],
  [78, 1, 'Bakery products', 'C:SEFB;BEA', 0, 'Food', [76,75,74,73,72,2]],
  [80, 1, 'Beef and veal', 'C:SEFC;BEA', 0, 'Food', [79,75,74,73,72,2]],
  [81, 1, 'Pork', 'C:SEFD;BEA', 0, 'Food', [79,75,74,73,72,2]],
  [82, 1, 'Other meats', 'C:SEFE;BEA', 0, 'Food', [79,75,74,73,72,2]],
  [83, 1, 'Poultry', 'C:SEFF;BEA', 0, 'Food', [79,75,74,73,72,2]],
  [84, 1, 'Fish and seafood', 'C:SEFG;BEA', 0, 'Food', [75,74,73,72,2]],
  [86, 1, 'Fresh milk', 'C:SEFJ01;BEA', 0, 'Food', [85,75,74,73,72,2]],
  [87, 1, 'Processed dairy products', 'C:SEFJ;BEA', 0, 'Food', [85,75,74,73,72,2]],
  [88, 1, 'Eggs', 'C:SEFH;BEA', 0, 'Food', [85,75,74,73,72,2]],
  [89, 1, 'Fats and oils', 'C:SEFS;BEA', 0, 'Food', [75,74,73,72,2]],
  [91, 1, 'Fruit (fresh)', 'C:SEFK;BEA', 0, 'Food', [90,75,74,73,72,2]],
  [92, 1, 'Vegetables (fresh)', 'C:SEFL;BEA', 0, 'Food', [90,75,74,73,72,2]],
  [93, 1, 'Processed fruits and vegetables', 'C:SEFM;BEA', 0, 'Food', [75,74,73,72,2]],
  [94, 1, 'Sugar and sweets', 'C:SEFR;BEA', 0, 'Food', [75,74,73,72,2]],
  [95, 1, 'Food products, not elsewhere classified', 'C:SEFT;BEA', 0, 'Food', [75,74,73,72,2]],
  [97, 1, 'Coffee, tea, and other beverage materials', 'C:SEFP;BEA', 0, 'Food', [96,74,73,72,2]],
  [98, 1, 'Mineral waters, soft drinks, and vegetable juices', 'C:SEFN;BEA', 0, 'Food', [96,74,73,72,2]],
  [100, 1, 'Spirits', 'C:SEFW02;BEA', 0, 'Food', [99,73,72,2]],
  [101, 1, 'Wine', 'C:SEFW03;BEA', 0, 'Food', [99,73,72,2]],
  [102, 1, 'Beer', 'C:SEFW01;BEA', 0, 'Food', [99,73,72,2]],
  [103, 1, 'Food produced and consumed on farms (6)', 'BEA', 0, 'Food', [73,72,2]],
  [106, 1, 'Women’s and girls’ clothing (10)', 'C:SAA2;BEA', 1, 'Core goods', [105,104,72,2]],
  [107, 1, 'Men’s and boys’ clothing (11)', 'C:SAA1;BEA', 1, 'Core goods', [105,104,72,2]],
  [108, 1, 'Children’s and infants’ clothing (12)', 'C:SEAF;BEA', 1, 'Core goods', [105,104,72,2]],
  [110, 1, 'Clothing materials', 'C:SERE02;BEA', 1, 'Core goods', [109,104,72,2]],
  [111, 1, 'Standard clothing issued to military personnel', 'P:WPU0381;BEA', 1, 'Core goods', [109,104,72,2]],
  [112, 1, 'Shoes and other footwear', 'C:SEAE;BEA', 1, 'Core goods', [109,104,72,2]],
  [115, 1, 'Gasoline and other motor fuel', 'C:SETB01;BEA', 0, 'Energy', [114,113,72,2]],
  [116, 1, 'Lubricants and fluids', 'C:SS47021;BEA', 0, 'Energy', [114,113,72,2]],
  [118, 1, 'Fuel oil', 'C:SEHE01;BEA', 0, 'Energy', [117,113,72,2]],
  [119, 1, 'Other fuels', 'C:SEHE02;BEA', 0, 'Energy', [117,113,72,2]],
  [123, 1, 'Prescription drugs', 'C:SEMF01;BEA', 1, 'Core goods', [122,121,120,72,2]],
  [124, 1, 'Nonprescription drugs', 'C:SEMF02;BEA', 1, 'Core goods', [122,121,120,72,2]],
  [125, 1, 'Other medical products', 'C:SEMG;BEA', 1, 'Core goods', [121,120,72,2]],
  [127, 1, 'Games, toys, and hobbies', 'C:SERE01;BEA', 1, 'Core goods', [126,120,72,2]],
  [128, 1, 'Pets and related products', 'C:SERB01;BEA', 1, 'Core goods', [126,120,72,2]],
  [129, 1, 'Flowers, seeds, and potted plants', 'C:SEHL02;BEA', 1, 'Core goods', [126,120,72,2]],
  [130, 1, 'Film and photographic supplies', 'C:SERD01;BEA', 1, 'Core goods', [126,120,72,2]],
  [132, 1, 'Household cleaning products', 'C:SEHN01;BEA', 1, 'Core goods', [131,120,72,2]],
  [133, 1, 'Household paper products', 'C:SEHN02;BEA', 1, 'Core goods', [131,120,72,2]],
  [134, 1, 'Household linens', 'C:SEHH03;BEA', 1, 'Core goods', [131,120,72,2]],
  [135, 1, 'Sewing items', 'C:SERE02;BEA', 1, 'Core goods', [131,120,72,2]],
  [136, 1, 'Miscellaneous household products', 'C:SEHN03;BEA', 1, 'Core goods', [131,120,72,2]],
  [138, 1, 'Hair, dental, shaving, and miscellaneous personal care products except electrical products', 'C:SEGB01;BEA', 1, 'Core goods', [137,120,72,2]],
  [139, 1, 'Cosmetic / perfumes / bath / nail preparations and implements', 'C:SEGB02;BEA', 1, 'Core goods', [137,120,72,2]],
  [140, 1, 'Electric appliances for personal care', 'C:SEGB01;C:SEHK02;BEA', 1, 'Core goods', [137,120,72,2]],
  [141, 1, 'Tobacco (127)', 'C:SEGA;BEA', 1, 'Core goods', [120,72,2]],
  [143, 1, 'Newspapers and periodicals', 'C:SERG01;BEA', 1, 'Core goods', [142,120,72,2]],
  [144, 1, 'Stationery and miscellaneous printed materials', 'C:SEGE;C:SEEA;BEA', 1, 'Core goods', [142,120,72,2]],
  [147, 1, 'Government employees’ expenditures abroad', 'BEA', 1, 'Core goods', [146,145,120,72,2]],
  [148, 1, 'Private employees’ expenditures abroad', 'BEA', 1, 'Core goods', [146,145,120,72,2]],
  [149, -1, 'Less: Personal remittances in kind to nonresidents', 'BEA', 1, 'Core goods', [145,120,72,2]],
  [155, 1, 'Tenant-occupied mobile homes', 'C:SEHA;BEA', 1, 'Housing', [154,153,152,151,150]],
  [159, 1, 'Tenant-occupied, including landlord durables', 'C:SEHA;BEA', 1, 'Housing', [156,154,153,152,151,150]],
  [161, 1, 'Owner-occupied mobile homes', 'C:SEHC;BEA', 1, 'Housing', [160,153,152,151,150]],
  [162, 1, 'Owner-occupied stationary homes', 'C:SEHC;BEA', 1, 'Housing', [160,153,152,151,150]],
  [163, 1, 'Rental value of farm dwellings (22)', 'C:SEHC;BEA', 1, 'Housing', [153,152,151,150]],
  [164, 1, 'Group housing (23)', 'C:SEHA;BEA', 1, 'Housing', [153,152,151,150]],
  [167, 1, 'Water supply and sewage maintenance', 'C:SEHG01;BEA', 1, 'Core services ex housing', [166,165,152,151,150]],
  [168, 1, 'Garbage and trash collection', 'C:SEHG02;BEA', 1, 'Core services ex housing', [166,165,152,151,150]],
  [170, 1, 'Electricity (27)', 'C:SEHF01;BEA', 0, 'Energy', [169,165,152,151,150]],
  [171, 1, 'Natural gas (28)', 'C:SEHF02;BEA', 0, 'Energy', [169,165,152,151,150]],
  [174, 1, 'Physician services (44)', 'P:PCU621111621111;BEA', 1, 'Core services ex housing', [173,172,151,150]],
  [175, 1, 'Dental services (45)', 'C:SEMC02;BEA', 1, 'Core services ex housing', [173,172,151,150]],
  [177, 1, 'Home health care', 'P:PCU621610621610;BEA', 1, 'Core services ex housing', [176,173,172,151,150]],
  [178, 1, 'Medical laboratories', 'P:PCU621511621511|P:PCU621512621512;BEA', 1, 'Core services ex housing', [176,173,172,151,150]],
  [180, 1, 'Specialty outpatient care facilities and health and allied services', 'C:SEMC04;BEA', 1, 'Core services ex housing', [179,176,173,172,151,150]],
  [181, 1, 'All other professional medical services', 'C:SEMC04;BEA', 1, 'Core services ex housing', [179,176,173,172,151,150]],
  [184, 1, 'Nonprofit hospitals’ services to households', 'P:PCU622---622---;BEA', 1, 'Core services ex housing', [183,182,172,151,150]],
  [185, 1, 'Proprietary hospitals', 'P:PCU622---622---;BEA', 1, 'Core services ex housing', [183,182,172,151,150]],
  [186, 1, 'Government hospitals', 'P:PCU622---622---;BEA', 1, 'Core services ex housing', [183,182,172,151,150]],
  [188, 1, 'Nonprofit nursing homes’ services to households', 'P:PCU623110623110;BEA', 1, 'Core services ex housing', [187,182,172,151,150]],
  [189, 1, 'Proprietary and government nursing homes', 'P:PCU623110623110;BEA', 1, 'Core services ex housing', [187,182,172,151,150]],
  [192, 1, 'Motor vehicle maintenance and repair (60)', 'C:SETD;BEA', 1, 'Core services ex housing', [191,190,151,150]],
  [195, 1, 'Auto leasing', 'C:SETA03;BEA', 1, 'Core services ex housing', [194,193,191,190,151,150]],
  [196, 1, 'Truck leasing', 'C:SETA03;BEA', 1, 'Core services ex housing', [194,193,191,190,151,150]],
  [197, 1, 'Motor vehicle rental', 'C:SETA04;BEA', 1, 'Core services ex housing', [193,191,190,151,150]],
  [198, 1, 'Parking fees and tolls', 'C:SETF03;BEA', 1, 'Core services ex housing', [193,191,190,151,150]],
  [201, 1, 'Railway transportation', 'C:SETG02;BEA', 1, 'Core services ex housing', [200,199,190,151,150]],
  [203, 1, 'Intercity buses', 'C:SETG02;BEA', 1, 'Core services ex housing', [202,200,199,190,151,150]],
  [204, 1, 'Taxicabs and ride sharing services', 'C:SETG03;BEA', 1, 'Core services ex housing', [202,200,199,190,151,150]],
  [205, 1, 'Intracity mass transit', 'C:SS53031;BEA', 1, 'Core services ex housing', [202,200,199,190,151,150]],
  [206, 1, 'Other road transportation service', 'C:SETG02;BEA', 1, 'Core services ex housing', [202,200,199,190,151,150]],
  [207, 1, 'Air transportation (64)', 'P:PCU4811114811111;P:PCU481111481111P;C:SETG01;BEA', 1, 'Core services ex housing', [199,190,151,150]],
  [208, 1, 'Water transportation (65)', 'C:SETG02;BEA', 1, 'Core services ex housing', [199,190,151,150]],
  [211, 1, 'Membership clubs and participant sports centers', 'C:SERF01;BEA', 1, 'Core services ex housing', [210,209,151,150]],
  [212, 1, 'Amusement parks, campgrounds, and related recreational services', 'C:SERF01;C:SERF02;BEA', 1, 'Core services ex housing', [210,209,151,150]],
  [214, 1, 'Motion picture theaters', 'C:SS62031;BEA', 1, 'Core services ex housing', [213,210,209,151,150]],
  [215, 1, 'Live entertainment, excluding sports', 'C:SS62031;BEA', 1, 'Core services ex housing', [213,210,209,151,150]],
  [216, 1, 'Spectator sports', 'C:SS62032;BEA', 1, 'Core services ex housing', [213,210,209,151,150]],
  [217, 1, 'Museums and libraries', 'C:SERF02;BEA', 1, 'Core services ex housing', [210,209,151,150]],
  [219, 1, 'Cable, satellite, and other live television services', 'C:SERA02;BEA', 1, 'Core services ex housing', [218,209,151,150]],
  [220, 1, 'Photo processing', 'C:SERD02;BEA', 1, 'Core services ex housing', [218,209,151,150]],
  [221, 1, 'Photo studios', 'C:SERD02;BEA', 1, 'Core services ex housing', [218,209,151,150]],
  [222, 1, 'Repair and rental of audio-visual, photographic, and information processing equipment', 'C:SERA02;BEA', 1, 'Core services ex housing', [218,209,151,150]],
  [224, 1, 'Video streaming and rental', 'C:SERA04;BEA', 1, 'Core services ex housing', [223,218,209,151,150]],
  [225, 1, 'Audio streaming and radio services (including satellite radio)', 'C:SERA06;BEA', 1, 'Core services ex housing', [223,218,209,151,150]],
  [227, 1, 'Casino gambling', 'BEA', 1, 'Core services ex housing', [226,209,151,150]],
  [228, 1, 'Lotteries', 'BEA', 1, 'Core services ex housing', [226,209,151,150]],
  [229, 1, 'Pari-mutuel net receipts', 'BEA', 1, 'Core services ex housing', [226,209,151,150]],
  [231, 1, 'Veterinary and other services for pets', 'C:SERB02;BEA', 1, 'Core services ex housing', [230,209,151,150]],
  [232, 1, 'Package tours', 'BEA;C:SETG01', 1, 'Core services ex housing', [230,209,151,150]],
  [233, 1, 'Maintenance and repair of recreational vehicles and sports equipment', 'C:SERC02;C:SEHP04;BEA', 1, 'Core services ex housing', [230,209,151,150]],
  [239, 1, 'Elementary and secondary school lunches', 'C:SEFV03;BEA', 1, 'Core services ex housing', [238,237,236,235,234,151,150]],
  [240, 1, 'Higher education school lunches', 'C:SEFV03;BEA', 1, 'Core services ex housing', [238,237,236,235,234,151,150]],
  [242, 1, 'Meals at limited service eating places', 'C:SEFV02;BEA', 1, 'Core services ex housing', [241,237,236,235,234,151,150]],
  [243, 1, 'Meals at other eating places', 'C:SEFV01;BEA', 1, 'Core services ex housing', [241,237,236,235,234,151,150]],
  [244, 1, 'Meals at drinking places', 'C:SEFV01;BEA', 1, 'Core services ex housing', [241,237,236,235,234,151,150]],
  [245, 1, 'Alcohol in purchased meals', 'C:SEFX;BEA', 1, 'Core services ex housing', [236,235,234,151,150]],
  [247, 1, 'Food supplied to civilians', 'C:SEFV01;BEA', 1, 'Core services ex housing', [246,235,234,151,150]],
  [248, 1, 'Food supplied to military', 'C:SEFV01;BEA', 1, 'Core services ex housing', [246,235,234,151,150]],
  [250, 1, 'Hotels and motels', 'C:SEHB02;BEA', 1, 'Core services ex housing', [249,234,151,150]],
  [251, 1, 'Housing at schools', 'C:SEHB01;BEA', 1, 'Core services ex housing', [249,234,151,150]],
  [255, 1, 'Commercial banks', 'BEA;P:PCU5221105221102;P:CES5500000003', 1, 'Core services ex housing', [254,253,252,151,150]],
  [256, 1, 'Other depository institutions and regulated investment companies', 'BEA;P:CES5500000003', 1, 'Core services ex housing', [254,253,252,151,150]],
  [257, 1, 'Pension funds', 'BEA', 1, 'Core services ex housing', [254,253,252,151,150]],
  [259, 1, 'Financial service charges and fees', 'C:SS68021;C:SEGD05;P:PCU5221105221102;BEA', 1, 'Core services ex housing', [258,253,252,151,150]],
  [262, 1, 'Exchange-listed equities', 'P:PCU5231505231501;BEA', 1, 'Core services ex housing', [261,260,258,253,252,151,150]],
  [263, 1, 'Other direct commissions', 'P:PCU5231505231501;BEA', 1, 'Core services ex housing', [261,260,258,253,252,151,150]],
  [265, 1, 'Over-the-counter equity securities', 'P:PCU5231505231501;BEA', 1, 'Core services ex housing', [264,260,258,253,252,151,150]],
  [266, 1, 'Other imputed commissions', 'P:PCU5231505231501;BEA', 1, 'Core services ex housing', [264,260,258,253,252,151,150]],
  [267, 1, 'Mutual fund sales charges', 'P:PCU5231505231501;BEA', 1, 'Core services ex housing', [260,258,253,252,151,150]],
  [268, 1, 'Portfolio management and investment advice services', 'P:PCU5239405239401;BEA', 1, 'Core services ex housing', [258,253,252,151,150]],
  [269, 1, 'Trust, fiduciary, and custody activities', 'P:PCU5221105221103;BEA', 1, 'Core services ex housing', [258,253,252,151,150]],
  [271, 1, 'Life insurance (110)', 'P:PCU524113524113;BEA;P:CES5500000003', 1, 'Core services ex housing', [270,252,151,150]],
  [272, 1, 'Net household insurance (111)', 'P:PCU524126524126;BEA', 1, 'Core services ex housing', [270,252,151,150]],
  [276, 1, 'Medical care and hospitalization', 'P:PCU524114524114;BEA', 1, 'Core services ex housing', [275,270,252,151,150]],
  [277, 1, 'Income loss', 'BEA', 1, 'Core services ex housing', [275,270,252,151,150]],
  [278, 1, 'Workers’ compensation', 'BEA', 1, 'Core services ex housing', [275,270,252,151,150]],
  [279, 1, 'Net motor vehicle and other transportation insurance (116)', 'C:SETE;BEA', 1, 'Core services ex housing', [270,252,151,150]],
  [283, 1, 'Land-line telephone services, local charges', 'C:SEED04;BEA', 1, 'Core services ex housing', [282,281,280,151,150]],
  [284, 1, 'Land-line telephone services, long-distance charges', 'C:SEED04;BEA', 1, 'Core services ex housing', [282,281,280,151,150]],
  [285, 1, 'Cellular telephone services', 'C:SEED03;BEA', 1, 'Core services ex housing', [282,281,280,151,150]],
  [287, 1, 'First-class postal service (by U.S. Postal Service)', 'C:SEEC01;BEA', 1, 'Core services ex housing', [286,281,280,151,150]],
  [288, 1, 'Other delivery services (by non-U.S. postal facilities)', 'C:SEEC02;BEA', 1, 'Core services ex housing', [286,281,280,151,150]],
  [289, 1, 'Internet access (72)', 'C:SEEE03;BEA', 1, 'Core services ex housing', [281,280,151,150]],
  [292, 1, 'Proprietary and public higher education', 'C:SEEB01;BEA', 1, 'Core services ex housing', [291,290,280,151,150]],
  [293, 1, 'Nonprofit private higher education services to households', 'C:SEEB01;BEA', 1, 'Core services ex housing', [291,290,280,151,150]],
  [295, 1, 'Elementary and secondary schools', 'C:SEEB02;BEA', 1, 'Core services ex housing', [294,290,280,151,150]],
  [296, 1, 'Day care and nursery schools', 'C:SEEB03;BEA', 1, 'Core services ex housing', [294,290,280,151,150]],
  [297, 1, 'Commercial and vocational schools (99)', 'C:SEEB04;BEA', 1, 'Core services ex housing', [290,280,151,150]],
  [299, 1, 'Legal services', 'P:PCU541110541110;C:SEGD01;BEA', 1, 'Core services ex housing', [298,280,151,150]],
  [301, 1, 'Tax preparation and other related services', 'C:SS68023;BEA', 1, 'Core services ex housing', [300,298,280,151,150]],
  [302, 1, 'Employment agency services', 'BEA;P:CES0800000003', 1, 'Core services ex housing', [300,298,280,151,150]],
  [303, 1, 'Other personal business services', 'BEA;C:SS68023', 1, 'Core services ex housing', [300,298,280,151,150]],
  [304, 1, 'Labor organization dues', 'BEA;P:CES0800000003', 1, 'Core services ex housing', [298,280,151,150]],
  [305, 1, 'Professional association dues', 'BEA;P:CES0800000003', 1, 'Core services ex housing', [298,280,151,150]],
  [306, 1, 'Funeral and burial services', 'C:SEGD02;BEA', 1, 'Core services ex housing', [298,280,151,150]],
  [309, 1, 'Hairdressing salons and personal grooming establishments', 'C:SEGC01;BEA', 1, 'Core services ex housing', [308,307,280,151,150]],
  [310, 1, 'Miscellaneous personal care services', 'C:SEGC;BEA', 1, 'Core services ex housing', [308,307,280,151,150]],
  [312, 1, 'Laundry and drycleaning services', 'C:SEGD03;BEA', 1, 'Core services ex housing', [311,307,280,151,150]],
  [313, 1, 'Clothing repair, rental, and alterations', 'C:SEGD04;BEA', 1, 'Core services ex housing', [311,307,280,151,150]],
  [314, 1, 'Repair and hire of footwear', 'C:SEGD04;BEA', 1, 'Core services ex housing', [311,307,280,151,150]],
  [316, 1, 'Child care', 'C:SEEB03;BEA', 1, 'Core services ex housing', [315,280,151,150]],
  [318, 1, 'Homes for the elderly', 'BEA;P:CES6500000003', 1, 'Core services ex housing', [317,315,280,151,150]],
  [319, 1, 'Residential mental health and substance abuse', 'BEA;P:CES6500000003', 1, 'Core services ex housing', [317,315,280,151,150]],
  [320, 1, 'Individual and family services', 'BEA;P:CES6500000003', 1, 'Core services ex housing', [317,315,280,151,150]],
  [321, 1, 'Vocational rehabilitation services', 'BEA;P:CES6500000003', 1, 'Core services ex housing', [317,315,280,151,150]],
  [322, 1, 'Community food and housing / emergency / other relief services', 'BEA;P:CES6500000003', 1, 'Core services ex housing', [317,315,280,151,150]],
  [323, 1, 'Other social assistance, not elsewere classified', 'BEA;P:CES6500000003', 1, 'Core services ex housing', [317,315,280,151,150]],
  [324, 1, 'Social advocacy and civic and social organizations', 'BEA;P:CES0800000003', 1, 'Core services ex housing', [315,280,151,150]],
  [325, 1, 'Religious organizations’ services to households', 'BEA;P:CES0800000003', 1, 'Core services ex housing', [315,280,151,150]],
  [326, 1, 'Foundations and grantmaking and giving services to households', 'BEA;P:CES0800000003', 1, 'Core services ex housing', [315,280,151,150]],
  [328, 1, 'Domestic services', 'C:SEHP01;BEA', 1, 'Core services ex housing', [327,280,151,150]],
  [329, 1, 'Moving, storage, and freight services', 'C:SEHP03;BEA', 1, 'Core services ex housing', [327,280,151,150]],
  [330, 1, 'Repair of furniture, furnishings, and floor coverings', 'C:SEHP04;BEA', 1, 'Core services ex housing', [327,280,151,150]],
  [331, 1, 'Repair of household appliances', 'C:SEHP04;BEA', 1, 'Core services ex housing', [327,280,151,150]],
  [332, 1, 'Other household services', 'C:SEHP02;BEA', 1, 'Core services ex housing', [327,280,151,150]],
  [335, 1, 'Passenger fares for foreign travel', 'P:PCU4811114811112;BEA;C:SETG01', 1, 'Core services ex housing', [334,333,280,151,150]],
  [336, 1, 'U.S. travel outside the United States', 'BEA', 1, 'Core services ex housing', [334,333,280,151,150]],
  [337, 1, 'U.S. student expenditures', 'BEA', 1, 'Core services ex housing', [334,333,280,151,150]],
  [339, -1, 'Foreign travel in the United States', 'BEA', 1, 'Core services ex housing', [338,333,280,151,150]],
  [340, -1, 'Medical expenditures of foreigners', 'BEA', 1, 'Core services ex housing', [338,333,280,151,150]],
  [341, -1, 'Expenditures of foreign students in the United States', 'BEA', 1, 'Core services ex housing', [338,333,280,151,150]],
  [342, 1, 'Final consumption expenditures of nonprofit institutions serving households (NPISHs) (132)', 'BEA;P:CES0800000003;P:CES6500000003', 1, 'Core services ex housing', [150]]
];

// ---------------------------------------------------------------------------
// Menu / entry point
// ---------------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Flash PCE')
    .addItem('Refresh', 'refreshFlashPce')
    .addToUi();
}

function refreshFlashPce() {
  var props = PropertiesService.getScriptProperties();
  var beaKey = props.getProperty('BEA_API_KEY'), blsKey = props.getProperty('BLS_API_KEY');
  if (!beaKey || !blsKey) throw new Error('Add BEA_API_KEY and BLS_API_KEY in Project Settings > Script Properties.');
  var y1 = new Date().getFullYear(), y0 = y1 - BACK_YEARS;

  var price = fetchBea_('U20404', y0, y1, beaKey);
  var nom   = fetchBea_('U20405', y0, y1, beaKey);
  var bls   = fetchBls_(blsIds_(), y0, y1, blsKey);
  var res = runModel_(price, nom, bls.data);
  res.blsFailed = bls.failed;
  writeOutput_(res);
}

// ---------------------------------------------------------------------------
// Data layer (the only part that touches Google services)
// ---------------------------------------------------------------------------
function fetchBea_(table, y0, y1, key) {
  var years = [];
  for (var y = y0; y <= y1; y++) years.push(y);
  var url = 'https://apps.bea.gov/api/data?UserID=' + key + '&method=GetData&DataSetName=NIUnderlyingDetail'
    + '&TableName=' + table + '&Frequency=M&Year=' + years.join(',') + '&ResultFormat=JSON';
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('BEA ' + table + ' HTTP ' + resp.getResponseCode());
  return parseBea_(JSON.parse(resp.getContentText()));
}

function fetchBls_(ids, y0, y1, key) {
  var data = {}, failed = [];
  for (var i = 0; i < ids.length; i += 50) {
    var chunk = ids.slice(i, i + 50);
    var body = { seriesid: chunk, startyear: String(y0), endyear: String(y1), registrationkey: key };
    var js = null;
    for (var attempt = 0; attempt < 4 && !js; attempt++) {
      try {
        var resp = UrlFetchApp.fetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
          method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true });
        if (resp.getResponseCode() === 200) js = JSON.parse(resp.getContentText());
      } catch (e) { /* retry */ }
      if (!js) Utilities.sleep(2000 * Math.pow(2, attempt));
    }
    if (!js || js.status !== 'REQUEST_SUCCEEDED') {
      failed.push('BLS batch ' + (i / 50 + 1) + ': ' + (js ? (js.message || []).join(' ') : 'no response'));
      if (!js) continue;
    }
    parseBls_(js, data);
  }
  return { data: data, failed: failed };
}

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------
/** -> { line: { 'YYYY-MM': value } } plus ._desc { line: description } */
function parseBea_(js) {
  var rows = js.BEAAPI.Results.Data, out = { _desc: {} };
  rows.forEach(function (r) {
    var l = +r.LineNumber, v = String(r.DataValue).replace(/,/g, '');
    if (v === '' || isNaN(+v)) return;
    if (!out[l]) { out[l] = {}; out._desc[l] = r.LineDescription; }
    out[l][r.TimePeriod.replace('M', '-')] = +v;
  });
  return out;
}

function parseBls_(js, data) {
  ((js.Results || {}).series || []).forEach(function (s) {
    var d = data[s.seriesID] || (data[s.seriesID] = {});
    (s.data || []).forEach(function (o) {
      if (o.period.charAt(0) !== 'M' || o.period === 'M13') return;
      var v = parseFloat(String(o.value).replace(/,/g, ''));
      if (!isNaN(v)) d[o.year + '-' + o.period.slice(1)] = v;
    });
  });
}

/** Every BLS series the mapping can use. */
function blsIds_() {
  var ids = {};
  LEAVES.forEach(function (lf) {
    lf[3].split(';').forEach(function (opt) {
      opt.split('|').forEach(function (p) {
        if (p.indexOf('C:') === 0) { ids['CUSR0000' + p.slice(2)] = 1; ids['CUUR0000' + p.slice(2)] = 1; }
        else if (p.indexOf('P:') === 0) ids[p.slice(2)] = 1;
      });
    });
  });
  return Object.keys(ids);
}

// ---------------------------------------------------------------------------
// Model (pure, no Google services: tested offline against the Python research version)
// ---------------------------------------------------------------------------
function ymAdd_(ym, n) {
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n;
  var yy = y + Math.floor(m / 12), mm = (m % 12 + 12) % 12 + 1;
  return yy + '-' + (mm < 10 ? '0' : '') + mm;
}
function momOf_(s, ym) {
  if (!s) return NaN;
  var a = s[ym], b = s[ymAdd_(ym, -1)];
  return (a == null || b == null) ? NaN : (a / b - 1) * 100;
}
function isNum_(v) { return typeof v === 'number' && !isNaN(v); }

/** Source MoM of one option at month ym; NaN if any component is missing. */
function sourceMom_(bls, opt, sa, ym) {
  var parts = opt.split('|'), sum = 0, n = 0;
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i], sid;
    if (p.indexOf('C:') === 0) {
      sid = (sa ? 'CUSR0000' : 'CUUR0000') + p.slice(2);
      if (sa && !hasData_(bls[sid])) sid = 'CUUR0000' + p.slice(2);
    } else if (p.indexOf('P:') === 0) sid = p.slice(2);
    else continue;
    if (!hasData_(bls[sid])) continue;          // series not available at all: drop component
    var v = momOf_(bls[sid], ym);
    if (!isNum_(v)) return NaN;
    sum += v; n++;
  }
  return n ? sum / n : null;                    // null = option unusable
}
function hasData_(s) { if (!s) return false; for (var k in s) return true; return false; }

/**
 * Candidate predictions for one line over all months: { name: { ym: value } }.
 * Same order and definitions as the Python version (first-best wins ties).
 */
function candidates_(y, bls, spec, months) {
  var out = {}, names = [];
  spec.split(';').forEach(function (opt) {
    if (opt === 'BEA') {
      [3, 6, 12, 24].forEach(function (n) {
        var c = {};
        months.forEach(function (t) { c[t] = trailingAvg_(y, t, n); });
        out['avg' + n] = c; names.push('avg' + n);
      });
      return;
    }
    [true, false].forEach(function (sa) {
      if (sourceMom_(bls, opt, sa, months[months.length - 1]) === null) return;
      var x = {}, diff = {};
      months.forEach(function (t) {
        x[t] = sourceMom_(bls, opt, sa, t);
        if (isNum_(y[t]) && isNum_(x[t])) diff[t] = y[t] - x[t];
      });
      var raw = {}, wed = {};
      months.forEach(function (t) {
        raw[t] = isNum_(x[t]) ? x[t] : NaN;
        wed[t] = isNum_(x[t]) ? x[t] + calWedge_(diff, t) : NaN;
      });
      var tag = opt + (sa ? '/SA' : '/NSA');
      out[tag] = raw; out[tag + '+w'] = wed; names.push(tag, tag + '+w');
    });
  });
  return { preds: out, names: names };
}

/** Mean of y over the n months with data strictly before t. */
function trailingAvg_(y, t, n) {
  var vals = [], k = 1;
  while (vals.length < n && k < 400) {
    var ym = ymAdd_(t, -k);
    if (isNum_(y[ym])) vals.push(y[ym]);
    k++;
  }
  return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : NaN;
}

/** Calendar-month correction: average (BEA - source) in the same month of the last WEDGE_YEARS years. */
function calWedge_(diff, t) {
  var vals = [];
  for (var k = 1; k <= WEDGE_YEARS; k++) {
    var d = diff[ymAdd_(t, -12 * k)];
    if (isNum_(d)) vals.push(d);
  }
  return vals.length >= 2 ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : 0;
}

/** Pick, for month index i, the candidate with the lowest MAE over the previous SEL_WINDOW months. */
function pick_(cand, y, months, i) {
  var best = null, be = Infinity, t = months[i];
  var hist = months.slice(Math.max(0, i - SEL_WINDOW), i).filter(function (s) { return SKIP.indexOf(s) < 0; });
  cand.names.forEach(function (k) {
    var c = cand.preds[k];
    if (!isNum_(c[t])) return;
    var s = 0, n = 0;
    hist.forEach(function (h) { if (isNum_(c[h]) && isNum_(y[h])) { s += Math.abs(c[h] - y[h]); n++; } });
    if (!n) return;
    if (s / n < be) { be = s / n; best = k; }
  });
  if (best === null) {
    for (var j = 0; j < cand.names.length; j++) if (isNum_(cand.preds[cand.names[j]][t])) { best = cand.names[j]; break; }
  }
  return best;
}

/** Fisher price relative with lagged (t-1) signed spending shares used as both base and current shares. */
function fisher_(rel, w) {
  var tot = 0, i;
  for (i = 0; i < w.length; i++) tot += w[i];
  var L = 0, Pinv = 0;
  for (i = 0; i < w.length; i++) { var s = w[i] / tot; L += s * rel[i]; Pinv += s / rel[i]; }
  return Math.sqrt(L / Pinv);
}

/** Estimate every line for month t (index i), fill gaps, aggregate. */
function estimateMonth_(ctx, i) {
  var t = ctx.months[i], tp = ymAdd_(t, -1), est = [];
  LEAVES.forEach(function (lf, j) {
    var k = pick_(ctx.cands[j], ctx.y[j], ctx.months, i);
    var v = k ? ctx.cands[j].preds[k][t] : NaN;
    var w = ctx.nom[lf[0]] ? ctx.nom[lf[0]][tp] : NaN;
    est.push({ lf: lf, method: k, mom: v, w: isNum_(w) ? lf[1] * w : NaN, how: methodClass_(k) });
  });
  // fill: nearest ancestor's share-weighted average of the other lines that have an estimate
  est.forEach(function (e) {
    if (isNum_(e.mom)) return;
    var anc = e.lf[6];
    for (var a = 0; a < anc.length; a++) {
      var s = 0, ws = 0;
      est.forEach(function (o) {
        if (o === e || !isNum_(o.mom) || !isNum_(o.w)) return;
        if (o.lf[6].indexOf(anc[a]) >= 0) { s += Math.abs(o.w) * o.mom; ws += Math.abs(o.w); }
      });
      if (ws) { e.mom = s / ws; e.how = 'filled'; e.method = 'parent avg (line ' + anc[a] + ')'; return; }
    }
  });
  var agg = function (filter) {
    var rel = [], w = [];
    est.forEach(function (e) {
      if (!filter(e) || !isNum_(e.mom) || !isNum_(e.w)) return;
      rel.push(1 + e.mom / 100); w.push(e.w);
    });
    return (fisher_(rel, w) - 1) * 100;
  };
  var head = agg(function () { return true; });
  var core = agg(function (e) { return e.lf[4] === 1; });
  // contributions (bp) using lagged shares: share * mom
  var totW = 0, coreW = 0;
  est.forEach(function (e) { if (isNum_(e.w)) { totW += e.w; if (e.lf[4]) coreW += e.w; } });
  est.forEach(function (e) {
    e.share = isNum_(e.w) ? e.w / totW * 100 : NaN;
    e.ch = isNum_(e.w) && isNum_(e.mom) ? e.w / totW * e.mom * 100 : NaN;
    e.cc = e.lf[4] && isNum_(e.w) && isNum_(e.mom) ? e.w / coreW * e.mom * 100 : NaN;
  });
  return { t: t, head: head, core: core, est: est };
}

function methodClass_(k) {
  if (!k) return 'none';
  if (k.indexOf('avg') === 0) return 'own history';
  return k.indexOf('C:') === 0 ? 'CPI' : (k.indexOf('P:CES') === 0 ? 'earnings' : 'PPI');
}

/**
 * Full run. price/nom: parsed BEA tables. bls: { id: { ym: value } }.
 * Returns the target-month estimate plus a BACKTEST_N-month out-of-sample record.
 */
function runModel_(price, nom, bls) {
  var pub = Object.keys(price[1]).sort();
  var lastPub = pub[pub.length - 1], target = ymAdd_(lastPub, 1);
  var months = [];
  for (var m = ymAdd_(pub[0], 1); m <= target; m = ymAdd_(m, 1)) months.push(m);

  var warnings = [];
  LEAVES.forEach(function (lf) {
    if (!price[lf[0]] || !nom[lf[0]]) warnings.push('BEA line ' + lf[0] + ' missing');
    else if (price._desc[lf[0]].replace(/[’']/g, '') !== lf[2].replace(/[’']/g, ''))
      warnings.push('BEA line ' + lf[0] + ' now reads "' + price._desc[lf[0]] + '" (mapping may need updating)');
  });

  var y = LEAVES.map(function (lf) {
    var o = {};
    months.forEach(function (t) { o[t] = momOf_(price[lf[0]], t); });
    return o;
  });
  var cands = LEAVES.map(function (lf, j) { return candidates_(y[j], bls, lf[3], months); });
  var ctx = { months: months, y: y, cands: cands, nom: nom };

  var now = estimateMonth_(ctx, months.length - 1);
  var bt = [];
  for (var i = Math.max(1, months.length - 1 - BACKTEST_N); i < months.length - 1; i++) {
    var r = estimateMonth_(ctx, i);
    bt.push({ t: r.t, head: r.head, core: r.core,
              aHead: momOf_(price[1], r.t), aCore: momOf_(price[374], r.t) });
  }
  // source availability for the target month
  var avail = function (id) { return bls[id] && bls[id][target] != null; };
  return { target: target, lastPub: lastPub, now: now, bt: bt, warnings: warnings,
           cpiOut: avail('CUSR0000SEHA') || avail('CUUR0000SEHA'),
           ppiOut: avail('PCU622---622---'),
           pceIdx: price[1], coreIdx: price[374] };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
function writeOutput_(res) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var now = res.now, t = res.target;
  var yoy = function (idx, mom) {
    var p = idx[ymAdd_(t, -1)], b = idx[ymAdd_(t, -12)];
    return (p == null || b == null) ? 'n/a' : r_((p * (1 + mom / 100) / b - 1) * 100, 2);
  };
  var ann = function (mom) { return r_((Math.pow(1 + mom / 100, 12) - 1) * 100, 2); };
  var st = btStats_(res.bt);

  // coverage by how each line was estimated
  var cov = {};
  now.est.forEach(function (e) { if (isNum_(e.share)) cov[e.how] = (cov[e.how] || 0) + e.share; });
  var status = res.cpiOut && res.ppiOut ? 'FINAL: CPI and PPI both in'
    : res.cpiOut ? 'PROVISIONAL: CPI in, PPI not yet (PPI lines use their next-best method)'
    : res.ppiOut ? 'PROVISIONAL: PPI in, CPI not yet'
    : 'WAITING: no CPI or PPI for ' + t + ' yet (estimate is own-history only)';

  var rows = [
    ['FLASH PCE NOWCAST', '', '', '', '', ''],
    ['Estimate for', t + '  (next PCE release)', '', 'Refreshed', new Date(), ''],
    ['Last published by BEA', res.lastPub, '', '', '', ''],
    ['Status', status, '', '', '', ''],
    ['', '', '', '', '', ''],
    ['', 'MoM %', 'Annualised %', 'Implied YoY %', 'Backtest MAE bp', 'Backtest RMSE bp'],
    ['Headline PCE', r_(now.head, 3), ann(now.head), yoy(res.pceIdx, now.head), r_(st.hMae, 1), r_(st.hRmse, 1)],
    ['Core PCE', r_(now.core, 3), ann(now.core), yoy(res.coreIdx, now.core), r_(st.cMae, 1), r_(st.cRmse, 1)],
    ['', '', '', '', '', ''],
    ['Backtest', 'last ' + res.bt.length + ' months, out of sample (method picked on prior 36m only)',
      '', '', '', ''],
    ['Share of PCE estimated by', Object.keys(cov).map(function (k) { return k + ' ' + r_(cov[k], 1) + '%'; }).join(' | '),
      '', '', '', ''],
    ['', '', '', '', '', '']
  ];
  // group contributions to headline
  var groups = ['Core goods', 'Housing', 'Core services ex housing', 'Food', 'Energy'], gc = {};
  now.est.forEach(function (e) { if (isNum_(e.ch)) gc[e.lf[5]] = (gc[e.lf[5]] || 0) + e.ch; });
  rows.push(['Contribution to headline', 'bp', '', '', '', '']);
  groups.forEach(function (g) { rows.push(['  ' + g, r_(gc[g] || 0, 1), '', '', '', '']); });
  rows.push(['', '', '', '', '', '']);
  rows.push(['Biggest line contributions', 'Weight %', 'MoM %', 'Headline bp', 'Core bp', 'Estimated by']);
  var top = now.est.filter(function (e) { return isNum_(e.ch); })
    .sort(function (a, b) { return Math.abs(b.ch) - Math.abs(a.ch); }).slice(0, 20);
  top.forEach(function (e) {
    rows.push([e.lf[2], r_(e.share, 2), r_(e.mom, 2), r_(e.ch, 1), isNum_(e.cc) ? r_(e.cc, 1) : '', label_(e)]);
  });
  var notes = res.warnings.concat(res.blsFailed || []);
  if (notes.length) { rows.push(['', '', '', '', '', '']); rows.push(['Warnings', notes.join(' | '), '', '', '', '']); }
  writeSheet_(ss, 'Flash PCE', rows, [0, 5, 15, 15 + groups.length + 2]);

  // all lines
  var lr = [['BEA line', 'Description', 'Group', 'Core', 'Weight %', 'MoM %', 'Headline bp', 'Core bp', 'Estimated by', 'Method']];
  now.est.forEach(function (e) {
    lr.push([e.lf[0], e.lf[2], e.lf[5], e.lf[4] ? 'yes' : 'no', r_(e.share, 3), r_(e.mom, 3),
             r_(e.ch, 2), isNum_(e.cc) ? r_(e.cc, 2) : '', e.how, e.method || '']);
  });
  writeSheet_(ss, 'Flash PCE lines', lr, [0]);

  // backtest
  var br = [['Month', 'Headline est', 'Headline actual', 'Error bp', 'Core est', 'Core actual', 'Error bp']];
  res.bt.forEach(function (b) {
    br.push([b.t, r_(b.head, 3), r_(b.aHead, 3), r_((b.head - b.aHead) * 100, 1),
             r_(b.core, 3), r_(b.aCore, 3), r_((b.core - b.aCore) * 100, 1)]);
  });
  br.push(['', '', '', '', '', '', '']);
  br.push(['MAE bp', '', '', r_(st.hMae, 2), '', '', r_(st.cMae, 2)]);
  br.push(['RMSE bp', '', '', r_(st.hRmse, 2), '', '', r_(st.cRmse, 2)]);
  br.push(['Bias bp', '', '', r_(st.hBias, 2), '', '', r_(st.cBias, 2)]);
  br.push(['Note', 'Oct/Nov 2025 (shutdown, no CPI) are excluded from the stats', '', '', '', '', '']);
  writeSheet_(ss, 'Flash PCE backtest', br, [0]);
}

function label_(e) {
  if (e.how === 'filled') return 'filled from parent category';
  if (e.how === 'own history') return 'own history (' + e.method + ')';
  return e.method;
}

function btStats_(bt) {
  var h = [], c = [];
  bt.forEach(function (b) {
    if (SKIP.indexOf(b.t) >= 0 || !isNum_(b.aHead)) return;
    h.push((b.head - b.aHead) * 100); c.push((b.core - b.aCore) * 100);
  });
  var mae = function (a) { return a.reduce(function (s, v) { return s + Math.abs(v); }, 0) / a.length; };
  var rmse = function (a) { return Math.sqrt(a.reduce(function (s, v) { return s + v * v; }, 0) / a.length); };
  var mean = function (a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; };
  return { hMae: mae(h), hRmse: rmse(h), hBias: mean(h), cMae: mae(c), cRmse: rmse(c), cBias: mean(c) };
}

function writeSheet_(ss, name, rows, boldRows) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  var w = 0;
  rows.forEach(function (r) { w = Math.max(w, r.length); });
  rows = rows.map(function (r) { r = r.slice(); while (r.length < w) r.push(''); return r; });
  sh.getRange(1, 1, rows.length, w).setValues(rows);
  boldRows.forEach(function (i) { sh.getRange(i + 1, 1, 1, w).setFontWeight('bold'); });
  if (name === 'Flash PCE') sh.getRange('A1').setFontSize(14);
  sh.setColumnWidth(1, 300);
  for (var c = 2; c <= w; c++) sh.setColumnWidth(c, name === 'Flash PCE lines' && c === 2 ? 320 : 120);
  try {
    sh.getRange(1, 1, rows.length, w).setWrapStrategy(SpreadsheetApp.WrapStrategy.OVERFLOW);
  } catch (e) { /* cosmetic */ }
  sh.setFrozenRows(name === 'Flash PCE' ? 0 : 1);
}

function r_(v, d) { if (!isNum_(v)) return ''; var p = Math.pow(10, d); return Math.round(v * p) / p; }

if (typeof module !== 'undefined') module.exports = { runModel_: runModel_, parseBea_: parseBea_, parseBls_: parseBls_,
  blsIds_: blsIds_, LEAVES: LEAVES, btStats_: btStats_ };
