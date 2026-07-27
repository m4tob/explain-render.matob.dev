/*
 * samples.js - example EXPLAIN output in JSON (MySQL 8.0 and PostgreSQL 16),
 * used to demo the viewer.
 */
(function (global) {
  'use strict';

  var samples = [
    {
      id: 'full-scan',
      name: 'Full table scan',
      sql: 'EXPLAIN FORMAT=JSON\nSELECT * FROM city WHERE Population > 1000000;',
      json: {
        query_block: {
          select_id: 1,
          cost_info: { query_cost: '412.40' },
          table: {
            table_name: 'city',
            access_type: 'ALL',
            rows_examined_per_scan: 4079,
            rows_produced_per_join: 1359,
            filtered: '33.33',
            cost_info: {
              read_cost: '276.51',
              eval_cost: '135.89',
              prefix_cost: '412.40',
              data_read_per_join: '308K'
            },
            used_columns: ['ID', 'Name', 'CountryCode', 'District', 'Population'],
            attached_condition: '(`world`.`city`.`Population` > 1000000)'
          }
        }
      }
    },
    {
      id: 'join-order',
      name: 'JOIN + ORDER BY',
      sql: 'EXPLAIN FORMAT=JSON\nSELECT co.Name, ci.Name, ci.Population\n' +
        '  FROM country co\n' +
        '  JOIN city ci ON ci.CountryCode = co.Code\n' +
        ' WHERE co.Continent = \'South America\'\n' +
        ' ORDER BY ci.Population DESC;',
      json: {
        query_block: {
          select_id: 1,
          cost_info: { query_cost: '319.71' },
          ordering_operation: {
            using_filesort: true,
            cost_info: { sort_cost: '61.20' },
            nested_loop: [
              {
                table: {
                  table_name: 'co',
                  access_type: 'ALL',
                  possible_keys: ['PRIMARY'],
                  rows_examined_per_scan: 239,
                  rows_produced_per_join: 23,
                  filtered: '10.00',
                  cost_info: {
                    read_cost: '22.51',
                    eval_cost: '2.39',
                    prefix_cost: '24.90',
                    data_read_per_join: '61K'
                  },
                  used_columns: ['Code', 'Name', 'Continent'],
                  attached_condition: "(`world`.`co`.`Continent` = 'South America')"
                }
              },
              {
                table: {
                  table_name: 'ci',
                  access_type: 'ref',
                  possible_keys: ['CountryCode'],
                  key: 'CountryCode',
                  used_key_parts: ['CountryCode'],
                  key_length: '3',
                  ref: ['world.co.Code'],
                  rows_examined_per_scan: 18,
                  rows_produced_per_join: 435,
                  filtered: '100.00',
                  cost_info: {
                    read_cost: '190.05',
                    eval_cost: '43.56',
                    prefix_cost: '258.51',
                    data_read_per_join: '40K'
                  },
                  used_columns: ['ID', 'Name', 'CountryCode', 'Population']
                }
              }
            ]
          }
        }
      }
    },
    {
      id: 'derived-group',
      name: 'Derived table + GROUP BY',
      sql: 'EXPLAIN FORMAT=JSON\nSELECT co.Name, t.total\n' +
        '  FROM country co\n' +
        '  JOIN (SELECT CountryCode, SUM(Population) AS total\n' +
        '          FROM city GROUP BY CountryCode) t\n' +
        '    ON t.CountryCode = co.Code\n' +
        ' WHERE co.Population > (SELECT AVG(Population) FROM country)\n' +
        ' ORDER BY t.total DESC;',
      json: {
        query_block: {
          select_id: 1,
          cost_info: { query_cost: '1543.87' },
          ordering_operation: {
            using_filesort: true,
            cost_info: { sort_cost: '23.90' },
            nested_loop: [
              {
                table: {
                  table_name: 'co',
                  access_type: 'ALL',
                  possible_keys: ['PRIMARY'],
                  rows_examined_per_scan: 239,
                  rows_produced_per_join: 79,
                  filtered: '33.33',
                  cost_info: {
                    read_cost: '17.03',
                    eval_cost: '7.97',
                    prefix_cost: '24.90',
                    data_read_per_join: '205K'
                  },
                  used_columns: ['Code', 'Name', 'Population'],
                  attached_condition: '(`world`.`co`.`Population` > (/* select#3 */ select ' +
                    'avg(`world`.`country`.`Population`) from `world`.`country`))',
                  attached_subqueries: [
                    {
                      dependent: false,
                      cacheable: true,
                      query_block: {
                        select_id: 3,
                        cost_info: { query_cost: '24.90' },
                        table: {
                          table_name: 'country',
                          access_type: 'ALL',
                          rows_examined_per_scan: 239,
                          rows_produced_per_join: 239,
                          filtered: '100.00',
                          cost_info: {
                            read_cost: '0.99',
                            eval_cost: '23.90',
                            prefix_cost: '24.90',
                            data_read_per_join: '616K'
                          },
                          used_columns: ['Population']
                        }
                      }
                    }
                  ]
                }
              },
              {
                table: {
                  table_name: 't',
                  access_type: 'ref',
                  possible_keys: ['<auto_key0>'],
                  key: '<auto_key0>',
                  used_key_parts: ['CountryCode'],
                  key_length: '3',
                  ref: ['world.co.Code'],
                  rows_examined_per_scan: 10,
                  rows_produced_per_join: 796,
                  filtered: '100.00',
                  cost_info: {
                    read_cost: '199.09',
                    eval_cost: '79.63',
                    prefix_cost: '1063.87',
                    data_read_per_join: '18K'
                  },
                  used_columns: ['CountryCode', 'total'],
                  materialized_from_subquery: {
                    using_temporary_table: true,
                    dependent: false,
                    cacheable: true,
                    query_block: {
                      select_id: 2,
                      cost_info: { query_cost: '820.05' },
                      grouping_operation: {
                        using_temporary_table: true,
                        using_filesort: false,
                        table: {
                          table_name: 'city',
                          access_type: 'index',
                          key: 'CountryCode',
                          used_key_parts: ['CountryCode'],
                          key_length: '3',
                          rows_examined_per_scan: 4079,
                          rows_produced_per_join: 4079,
                          filtered: '100.00',
                          using_index: true,
                          cost_info: {
                            read_cost: '412.15',
                            eval_cost: '407.90',
                            prefix_cost: '820.05',
                            data_read_per_join: '382K'
                          },
                          used_columns: ['CountryCode', 'Population']
                        }
                      }
                    }
                  }
                }
              }
            ]
          }
        }
      }
    },
    {
      id: 'union',
      name: 'UNION',
      sql: 'EXPLAIN FORMAT=JSON\nSELECT Name FROM city WHERE Population > 5000000\n' +
        'UNION\nSELECT Name FROM country WHERE Population > 100000000;',
      json: {
        query_block: {
          union_result: {
            using_temporary_table: true,
            table_name: '<union1,2>',
            access_type: 'ALL',
            query_specifications: [
              {
                dependent: false,
                cacheable: true,
                query_block: {
                  select_id: 1,
                  cost_info: { query_cost: '412.40' },
                  table: {
                    table_name: 'city',
                    access_type: 'ALL',
                    rows_examined_per_scan: 4079,
                    rows_produced_per_join: 1359,
                    filtered: '33.33',
                    cost_info: {
                      read_cost: '276.51',
                      eval_cost: '135.89',
                      prefix_cost: '412.40',
                      data_read_per_join: '308K'
                    },
                    used_columns: ['Name', 'Population'],
                    attached_condition: '(`world`.`city`.`Population` > 5000000)'
                  }
                }
              },
              {
                dependent: false,
                cacheable: true,
                query_block: {
                  select_id: 2,
                  cost_info: { query_cost: '24.90' },
                  table: {
                    table_name: 'country',
                    access_type: 'ALL',
                    rows_examined_per_scan: 239,
                    rows_produced_per_join: 79,
                    filtered: '33.33',
                    cost_info: {
                      read_cost: '17.03',
                      eval_cost: '7.97',
                      prefix_cost: '24.90',
                      data_read_per_join: '205K'
                    },
                    used_columns: ['Name', 'Population'],
                    attached_condition: '(`world`.`country`.`Population` > 100000000)'
                  }
                }
              }
            ]
          }
        }
      }
    },
    {
      id: 'index-lookup',
      name: 'Unique key lookup',
      sql: 'EXPLAIN FORMAT=JSON\nSELECT c.Name, co.Name\n  FROM city c\n' +
        '  JOIN country co ON co.Code = c.CountryCode\n WHERE c.ID = 1890;',
      json: {
        query_block: {
          select_id: 1,
          cost_info: { query_cost: '1.40' },
          nested_loop: [
            {
              table: {
                table_name: 'c',
                access_type: 'const',
                possible_keys: ['PRIMARY', 'CountryCode'],
                key: 'PRIMARY',
                used_key_parts: ['ID'],
                key_length: '4',
                ref: ['const'],
                rows_examined_per_scan: 1,
                rows_produced_per_join: 1,
                filtered: '100.00',
                cost_info: {
                  read_cost: '0.00',
                  eval_cost: '0.00',
                  prefix_cost: '0.00',
                  data_read_per_join: '96'
                },
                used_columns: ['ID', 'Name', 'CountryCode']
              }
            },
            {
              table: {
                table_name: 'co',
                access_type: 'const',
                possible_keys: ['PRIMARY'],
                key: 'PRIMARY',
                used_key_parts: ['Code'],
                key_length: '3',
                ref: ['const'],
                rows_examined_per_scan: 1,
                rows_produced_per_join: 1,
                filtered: '100.00',
                cost_info: {
                  read_cost: '0.00',
                  eval_cost: '0.00',
                  prefix_cost: '0.00',
                  data_read_per_join: '2K'
                },
                used_columns: ['Code', 'Name']
              }
            }
          ]
        }
      }
    }
  ];

  samples.forEach(function (s) { s.dialect = 'mysql'; });

  var pgSamples = [
    {
      id: 'pg-seq-scan',
      name: 'Seq Scan',
      sql: 'EXPLAIN (FORMAT JSON)\nSELECT * FROM city WHERE population > 1000000;',
      json: [
        {
          Plan: {
            'Node Type': 'Seq Scan',
            'Parallel Aware': false,
            'Relation Name': 'city',
            Alias: 'city',
            'Startup Cost': 0.00,
            'Total Cost': 93.99,
            'Plan Rows': 237,
            'Plan Width': 49,
            Filter: '(population > 1000000)'
          }
        }
      ]
    },
    {
      id: 'pg-hash-join',
      name: 'Hash Join + Sort (ANALYZE)',
      sql: 'EXPLAIN (FORMAT JSON, ANALYZE)\nSELECT co.name, c.name, c.population\n' +
        '  FROM city c\n  JOIN country co ON co.code = c.countrycode\n' +
        ' WHERE co.continent = \'South America\'\n ORDER BY c.population DESC;',
      json: [
        {
          Plan: {
            'Node Type': 'Sort',
            'Parallel Aware': false,
            'Startup Cost': 156.32,
            'Total Cost': 157.85,
            'Plan Rows': 612,
            'Plan Width': 48,
            'Actual Startup Time': 3.412,
            'Actual Total Time': 3.498,
            'Actual Rows': 594,
            'Actual Loops': 1,
            'Sort Key': ['c.population DESC'],
            'Sort Method': 'quicksort',
            'Sort Space Used': 78,
            'Sort Space Type': 'Memory',
            Plans: [
              {
                'Node Type': 'Hash Join',
                'Parent Relationship': 'Outer',
                'Join Type': 'Inner',
                'Startup Cost': 8.38,
                'Total Cost': 127.95,
                'Plan Rows': 612,
                'Plan Width': 48,
                'Actual Startup Time': 0.241,
                'Actual Total Time': 3.109,
                'Actual Rows': 594,
                'Actual Loops': 1,
                'Hash Cond': '(c.countrycode = co.code)',
                Plans: [
                  {
                    'Node Type': 'Seq Scan',
                    'Parent Relationship': 'Outer',
                    'Relation Name': 'city',
                    Alias: 'c',
                    'Startup Cost': 0.00,
                    'Total Cost': 93.79,
                    'Plan Rows': 4079,
                    'Plan Width': 32,
                    'Actual Startup Time': 0.011,
                    'Actual Total Time': 1.204,
                    'Actual Rows': 4079,
                    'Actual Loops': 1
                  },
                  {
                    'Node Type': 'Hash',
                    'Parent Relationship': 'Inner',
                    'Startup Cost': 7.93,
                    'Total Cost': 7.93,
                    'Plan Rows': 36,
                    'Plan Width': 24,
                    'Actual Startup Time': 0.198,
                    'Actual Total Time': 0.199,
                    'Actual Rows': 14,
                    'Actual Loops': 1,
                    'Hash Buckets': 1024,
                    'Hash Batches': 1,
                    'Peak Memory Usage': 9,
                    Plans: [
                      {
                        'Node Type': 'Index Scan',
                        'Parent Relationship': 'Outer',
                        'Relation Name': 'country',
                        Alias: 'co',
                        'Index Name': 'country_continent_idx',
                        'Startup Cost': 0.14,
                        'Total Cost': 7.93,
                        'Plan Rows': 36,
                        'Plan Width': 24,
                        'Actual Startup Time': 0.032,
                        'Actual Total Time': 0.164,
                        'Actual Rows': 14,
                        'Actual Loops': 1,
                        'Index Cond': "(continent = 'South America'::text)"
                      }
                    ]
                  }
                ]
              }
            ]
          },
          'Planning Time': 0.412,
          'Execution Time': 3.611
        }
      ]
    },
    {
      id: 'pg-bitmap',
      name: 'Bitmap Scan + Aggregate',
      sql: 'EXPLAIN (FORMAT JSON, ANALYZE)\nSELECT count(*), sum(population)\n' +
        '  FROM city WHERE countrycode = \'BRA\';',
      json: [
        {
          Plan: {
            'Node Type': 'Aggregate',
            Strategy: 'Plain',
            'Partial Mode': 'Simple',
            'Startup Cost': 43.29,
            'Total Cost': 43.30,
            'Plan Rows': 1,
            'Plan Width': 16,
            'Actual Startup Time': 0.288,
            'Actual Total Time': 0.289,
            'Actual Rows': 1,
            'Actual Loops': 1,
            Plans: [
              {
                'Node Type': 'Bitmap Heap Scan',
                'Parent Relationship': 'Outer',
                'Relation Name': 'city',
                Alias: 'city',
                'Startup Cost': 5.31,
                'Total Cost': 42.36,
                'Plan Rows': 250,
                'Plan Width': 4,
                'Actual Startup Time': 0.048,
                'Actual Total Time': 0.208,
                'Actual Rows': 250,
                'Actual Loops': 1,
                'Recheck Cond': "(countrycode = 'BRA'::bpchar)",
                'Heap Blocks': 'exact=23',
                'Shared Hit Blocks': 25,
                Plans: [
                  {
                    'Node Type': 'Bitmap Index Scan',
                    'Parent Relationship': 'Outer',
                    'Index Name': 'city_countrycode_idx',
                    'Startup Cost': 0.00,
                    'Total Cost': 5.25,
                    'Plan Rows': 250,
                    'Plan Width': 0,
                    'Actual Startup Time': 0.031,
                    'Actual Total Time': 0.031,
                    'Actual Rows': 250,
                    'Actual Loops': 1,
                    'Index Cond': "(countrycode = 'BRA'::bpchar)"
                  }
                ]
              }
            ]
          },
          'Planning Time': 0.194,
          'Execution Time': 0.334
        }
      ]
    },
    {
      id: 'pg-append',
      name: 'Append (partitions)',
      sql: 'EXPLAIN (FORMAT JSON)\nSELECT * FROM readings\n' +
        ' WHERE collected_at >= \'2026-01-01\' AND value > 90;',
      json: [
        {
          Plan: {
            'Node Type': 'Append',
            'Startup Cost': 0.00,
            'Total Cost': 428.66,
            'Plan Rows': 1104,
            'Plan Width': 24,
            Plans: [
              {
                'Node Type': 'Seq Scan',
                'Parent Relationship': 'Member',
                'Relation Name': 'readings_2026_01',
                Alias: 'readings_1',
                'Startup Cost': 0.00,
                'Total Cost': 189.00,
                'Plan Rows': 612,
                'Plan Width': 24,
                Filter: '(value > 90)'
              },
              {
                'Node Type': 'Seq Scan',
                'Parent Relationship': 'Member',
                'Relation Name': 'readings_2026_02',
                Alias: 'readings_2',
                'Startup Cost': 0.00,
                'Total Cost': 178.00,
                'Plan Rows': 402,
                'Plan Width': 24,
                Filter: '(value > 90)'
              },
              {
                'Node Type': 'Index Scan',
                'Parent Relationship': 'Member',
                'Relation Name': 'readings_2026_03',
                Alias: 'readings_3',
                'Index Name': 'readings_2026_03_value_idx',
                'Startup Cost': 0.29,
                'Total Cost': 61.66,
                'Plan Rows': 90,
                'Plan Width': 24,
                'Index Cond': '(value > 90)'
              }
            ]
          }
        }
      ]
    },
    {
      id: 'pg-nested-loop',
      name: 'Nested Loop with a bad estimate',
      sql: 'EXPLAIN (FORMAT JSON, ANALYZE)\nSELECT o.name, i.quantity\n' +
        '  FROM orders o\n  JOIN items i ON i.order_id = o.id\n' +
        ' WHERE o.status = \'open\';',
      json: [
        {
          Plan: {
            'Node Type': 'Nested Loop',
            'Join Type': 'Inner',
            'Startup Cost': 0.29,
            'Total Cost': 812.44,
            'Plan Rows': 96,
            'Plan Width': 36,
            'Actual Startup Time': 0.062,
            'Actual Total Time': 214.883,
            'Actual Rows': 18422,
            'Actual Loops': 1,
            Plans: [
              {
                'Node Type': 'Seq Scan',
                'Parent Relationship': 'Outer',
                'Relation Name': 'orders',
                Alias: 'o',
                'Startup Cost': 0.00,
                'Total Cost': 388.00,
                'Plan Rows': 24,
                'Plan Width': 28,
                'Actual Startup Time': 0.021,
                'Actual Total Time': 6.114,
                'Actual Rows': 4106,
                'Actual Loops': 1,
                Filter: "(status = 'open'::text)",
                'Rows Removed by Filter': 15894
              },
              {
                'Node Type': 'Index Scan',
                'Parent Relationship': 'Inner',
                'Relation Name': 'items',
                Alias: 'i',
                'Index Name': 'items_order_id_idx',
                'Startup Cost': 0.29,
                'Total Cost': 17.60,
                'Plan Rows': 4,
                'Plan Width': 12,
                'Actual Startup Time': 0.008,
                'Actual Total Time': 0.044,
                'Actual Rows': 4,
                'Actual Loops': 4106,
                'Index Cond': '(order_id = o.id)'
              }
            ]
          },
          'Planning Time': 0.331,
          'Execution Time': 216.402
        }
      ]
    }
  ];

  pgSamples.forEach(function (s) { s.dialect = 'postgres'; });

  global.VE = global.VE || {};
  global.VE.samples = samples.concat(pgSamples);
})(window);
