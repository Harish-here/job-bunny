/**
 * The frozen persona catalog: 11 curated presets (10 role personas plus
 * `scratch`, a blank-slate escape hatch) the onboarding wizard offers.
 * Lives as a typed constant in `core/` rather than a `.json` file read
 * from disk at request time — `core/` is pure and is one of the only two
 * layers `app/` may import, so the route can serve this object directly
 * with no port, no adapter, and no filesystem access. That also sidesteps
 * a real hazard the data-home work hit twice: a repo-shipped file read
 * through the data home resolves to the wrong place, and reading it
 * correctly requires `import.meta.url` package-root math this static,
 * read-only endpoint has no reason to carry.
 *
 * `title.*` rule terms are all lowercase because the filter engine
 * matches title text case-insensitively and phase-3 derivation copies
 * these strings straight through into `filter.json`. Skill names and
 * seniority labels are display-cased because they are shown to the user
 * and written into `resume.json` as-is.
 */
import type { PersonaCatalog } from './types.ts';

export const PERSONA_CATALOG: PersonaCatalog = {
  version: 1,
  personas: [
    {
      id: 'frontend',
      label: 'Frontend',
      blurb:
        'Browser-side product work: UI architecture, design systems, and the app shell.',
      coreSkills: ['React', 'TypeScript', 'JavaScript', 'CSS', 'HTML', 'UI Architecture'],
      secondarySkills: [
        'Next.js',
        'Vue.js',
        'Redux',
        'Testing Library',
        'Webpack',
        'Design Systems',
      ],
      seniorityOptions: ['Junior', 'Mid', 'Senior', 'Staff', 'Lead', 'Principal'],
      title: {
        domain: {
          match: [
            'frontend',
            'front-end',
            'front end',
            'ui',
            'web',
            'react',
            'design systems',
          ],
          reject: [],
        },
        function: {
          match: ['engineer', 'developer', 'architect'],
          reject: [
            'manager',
            'director',
            'vp',
            'vice president',
            'recruiter',
            'analyst',
            'intern',
          ],
        },
      },
    },
    {
      id: 'backend',
      label: 'Backend',
      blurb: 'Server-side services, APIs, and the data layer behind the product.',
      coreSkills: [
        'Node.js',
        'TypeScript',
        'APIs',
        'SQL',
        'System Design',
        'Microservices',
      ],
      secondarySkills: ['Java', 'Go', 'Python', 'PostgreSQL', 'Redis', 'gRPC'],
      seniorityOptions: ['Junior', 'Mid', 'Senior', 'Staff', 'Lead', 'Principal'],
      title: {
        domain: {
          match: [
            'backend',
            'back-end',
            'back end',
            'server',
            'api',
            'platform',
            'distributed systems',
          ],
          reject: [],
        },
        function: {
          match: ['engineer', 'developer', 'architect'],
          reject: [
            'manager',
            'director',
            'vp',
            'vice president',
            'recruiter',
            'analyst',
            'intern',
          ],
        },
      },
    },
    {
      id: 'fullstack',
      label: 'Fullstack',
      blurb: 'End-to-end product engineering across the browser and the server.',
      coreSkills: ['TypeScript', 'React', 'Node.js', 'SQL', 'APIs', 'System Design'],
      secondarySkills: ['Next.js', 'PostgreSQL', 'AWS', 'Docker', 'GraphQL', 'Testing'],
      seniorityOptions: ['Junior', 'Mid', 'Senior', 'Staff', 'Lead', 'Principal'],
      title: {
        domain: {
          match: [
            'fullstack',
            'full-stack',
            'full stack',
            'product engineer',
            'web',
            'software',
          ],
          reject: [],
        },
        function: {
          match: ['engineer', 'developer', 'architect'],
          reject: [
            'manager',
            'director',
            'vp',
            'vice president',
            'recruiter',
            'analyst',
            'intern',
          ],
        },
      },
    },
    {
      id: 'data',
      label: 'Data',
      blurb: 'Pipelines, warehouses, and analytics that turn raw events into decisions.',
      coreSkills: ['SQL', 'Python', 'ETL', 'Data Modeling', 'Airflow', 'Spark'],
      secondarySkills: ['dbt', 'Snowflake', 'BigQuery', 'Kafka', 'Pandas', 'Tableau'],
      seniorityOptions: ['Junior', 'Mid', 'Senior', 'Staff', 'Lead', 'Principal'],
      title: {
        domain: {
          match: ['data', 'analytics', 'machine learning', 'ml', 'warehouse', 'bi'],
          reject: [],
        },
        function: {
          match: ['engineer', 'scientist', 'analyst', 'architect'],
          reject: ['manager', 'director', 'vp', 'vice president', 'recruiter', 'intern'],
        },
      },
    },
    {
      id: 'devops',
      label: 'DevOps / SRE',
      blurb: 'Delivery pipelines, cloud infrastructure, and production reliability.',
      coreSkills: ['Kubernetes', 'Terraform', 'AWS', 'CI/CD', 'Docker', 'Linux'],
      secondarySkills: [
        'Prometheus',
        'Grafana',
        'Ansible',
        'GCP',
        'Bash',
        'Observability',
      ],
      seniorityOptions: ['Junior', 'Mid', 'Senior', 'Staff', 'Lead', 'Principal'],
      title: {
        domain: {
          match: [
            'devops',
            'sre',
            'site reliability',
            'infrastructure',
            'platform',
            'cloud',
          ],
          reject: [],
        },
        function: {
          match: ['engineer', 'architect', 'specialist'],
          reject: ['manager', 'director', 'vp', 'vice president', 'recruiter', 'intern'],
        },
      },
    },
    {
      id: 'product',
      label: 'Product',
      blurb: 'Discovery, roadmap, and the specifics of what gets built and why.',
      coreSkills: [
        'Product Strategy',
        'Roadmapping',
        'User Research',
        'Analytics',
        'Stakeholder Management',
        'Agile',
      ],
      secondarySkills: ['SQL', 'A/B Testing', 'Figma', 'Jira', 'Go-to-Market', 'Pricing'],
      seniorityOptions: ['Associate', 'Mid', 'Senior', 'Lead', 'Principal', 'Director'],
      title: {
        domain: {
          match: ['product'],
          reject: ['product marketing', 'product design'],
        },
        function: {
          match: ['manager', 'owner', 'lead', 'director'],
          reject: ['engineer', 'developer', 'designer', 'recruiter', 'intern'],
        },
      },
    },
    {
      id: 'design',
      label: 'Design',
      blurb: 'Product and interaction design, from flows to a maintained design system.',
      coreSkills: [
        'Figma',
        'Interaction Design',
        'Design Systems',
        'Prototyping',
        'User Research',
        'Accessibility',
      ],
      secondarySkills: [
        'Wireframing',
        'Usability Testing',
        'Motion Design',
        'HTML',
        'CSS',
        'Branding',
      ],
      seniorityOptions: ['Junior', 'Mid', 'Senior', 'Staff', 'Lead', 'Principal'],
      title: {
        domain: {
          match: ['design', 'ux', 'ui', 'product design', 'experience'],
          reject: ['graphic design', 'motion graphics'],
        },
        function: {
          match: ['designer', 'researcher', 'lead'],
          reject: ['engineer', 'developer', 'recruiter', 'intern'],
        },
      },
    },
    {
      id: 'csm',
      label: 'Customer Success',
      blurb: 'Onboarding, adoption, retention, and renewal for existing customers.',
      coreSkills: [
        'Customer Success',
        'Onboarding',
        'Account Management',
        'Renewals',
        'Churn Reduction',
        'QBRs',
      ],
      secondarySkills: [
        'Salesforce',
        'Gainsight',
        'Upselling',
        'SaaS',
        'Escalation Management',
        'Zendesk',
      ],
      seniorityOptions: ['Associate', 'Mid', 'Senior', 'Lead', 'Manager', 'Director'],
      title: {
        domain: {
          match: [
            'customer success',
            'customer experience',
            'account management',
            'client success',
          ],
          reject: [],
        },
        function: {
          match: ['manager', 'specialist', 'lead', 'director', 'partner'],
          reject: ['engineer', 'developer', 'recruiter', 'intern'],
        },
      },
    },
    {
      id: 'sales',
      label: 'Sales',
      blurb: 'Pipeline, new business, and closing revenue.',
      coreSkills: [
        'B2B Sales',
        'Pipeline Management',
        'Prospecting',
        'Negotiation',
        'Quota Attainment',
        'CRM',
      ],
      secondarySkills: [
        'Salesforce',
        'Outreach',
        'SaaS',
        'Enterprise Sales',
        'Forecasting',
        'Cold Outreach',
      ],
      seniorityOptions: ['Associate', 'Mid', 'Senior', 'Lead', 'Manager', 'Director'],
      title: {
        domain: {
          match: ['sales', 'business development', 'revenue', 'account executive'],
          reject: [],
        },
        function: {
          match: ['executive', 'manager', 'representative', 'director', 'lead'],
          reject: ['engineer', 'developer', 'recruiter', 'intern'],
        },
      },
    },
    {
      id: 'marketing',
      label: 'Marketing',
      blurb: 'Demand, positioning, content, and the growth funnel.',
      coreSkills: [
        'Content Marketing',
        'SEO',
        'Demand Generation',
        'Positioning',
        'Campaign Management',
        'Analytics',
      ],
      secondarySkills: [
        'HubSpot',
        'Google Analytics',
        'Paid Ads',
        'Email Marketing',
        'Copywriting',
        'Product Marketing',
      ],
      seniorityOptions: ['Associate', 'Mid', 'Senior', 'Lead', 'Manager', 'Director'],
      title: {
        domain: {
          match: ['marketing', 'growth', 'demand generation', 'brand', 'content'],
          reject: [],
        },
        function: {
          match: ['manager', 'specialist', 'lead', 'director', 'strategist'],
          reject: ['engineer', 'developer', 'recruiter', 'intern'],
        },
      },
    },
    {
      id: 'scratch',
      label: 'Start from scratch',
      blurb: 'Blank slate — fill in your own skills and title rules.',
      coreSkills: [],
      secondarySkills: [],
      seniorityOptions: [
        'Junior',
        'Mid',
        'Senior',
        'Staff',
        'Lead',
        'Principal',
        'Manager',
        'Director',
      ],
      title: {
        domain: { match: [], reject: [] },
        function: { match: [], reject: [] },
      },
    },
  ],
};
