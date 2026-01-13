import { pool } from './pool';
import { v4 as uuidv4 } from 'uuid';

async function seedData(emailOrOrgId?: string) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let organizationId: string;
    let userId: string;

    if (emailOrOrgId) {
      if (emailOrOrgId.includes('@')) {
        const userResult = await client.query(
          'SELECT id, organization_id FROM users WHERE email = $1',
          [emailOrOrgId]
        );
        if (userResult.rows.length === 0) {
          console.log(`✗ No user found with email: ${emailOrOrgId}`);
          await client.query('ROLLBACK');
          return;
        }
        userId = userResult.rows[0].id;
        organizationId = userResult.rows[0].organization_id;
      } else {
        const orgResult = await client.query('SELECT id FROM organizations WHERE id = $1', [emailOrOrgId]);
        if (orgResult.rows.length === 0) {
          console.log(`✗ No organization found with ID: ${emailOrOrgId}`);
          await client.query('ROLLBACK');
          return;
        }
        organizationId = orgResult.rows[0].id;
        const userResult = await client.query('SELECT id FROM users WHERE organization_id = $1 LIMIT 1', [organizationId]);
        userId = userResult.rows[0]?.id;
      }
    } else {
      const orgsResult = await client.query('SELECT id, name FROM organizations ORDER BY created_at');
      if (orgsResult.rows.length === 0) {
        console.log('No organizations found. Please create an account first via /auth/signup');
        await client.query('ROLLBACK');
        return;
      }

      if (orgsResult.rows.length === 1) {
        organizationId = orgsResult.rows[0].id;
        const userResult = await client.query('SELECT id FROM users WHERE organization_id = $1 LIMIT 1', [organizationId]);
        userId = userResult.rows[0]?.id;
        console.log(`Seeding data for organization: ${orgsResult.rows[0].name} (${organizationId})`);
      } else {
        console.log('\nMultiple organizations found:');
        orgsResult.rows.forEach((org, index) => {
          console.log(`  ${index + 1}. ${org.name} (${org.id})`);
        });
        console.log('\nPlease specify which organization to seed:');
        console.log('  npm run seed -- <email> or <organization_id>');
        console.log('  Example: npm run seed -- admin@example.com');
        await client.query('ROLLBACK');
        return;
      }
    }

    if (!userId) {
      console.log('✗ No user found for organization');
      await client.query('ROLLBACK');
      return;
    }

    const orgResult = await client.query('SELECT name FROM organizations WHERE id = $1', [organizationId]);
    console.log(`\nSeeding data for organization: ${orgResult.rows[0].name} (${organizationId})`);

    const verifications = [
      {
        display_name: 'Sarah J.',
        id_type: 'Passport',
        match_score: 98,
        risk_level: 'Low',
        status: 'Approved',
        is_auto_approved: true,
      },
      {
        display_name: 'Michael Chen',
        id_type: 'National ID',
        match_score: 95,
        risk_level: 'Low',
        status: 'Approved',
        is_auto_approved: true,
      },
      {
        display_name: 'Emma Wilson',
        id_type: 'Driver License',
        match_score: 87,
        risk_level: 'Medium',
        status: 'Pending',
        is_auto_approved: false,
      },
      {
        display_name: 'James Rodriguez',
        id_type: 'Passport',
        match_score: 72,
        risk_level: 'High',
        status: 'Flagged',
        is_auto_approved: false,
      },
      {
        display_name: 'Priya Patel',
        id_type: 'National ID',
        match_score: 99,
        risk_level: 'Low',
        status: 'Approved',
        is_auto_approved: true,
      },
      {
        display_name: 'David Kim',
        id_type: 'Driver License',
        match_score: 65,
        risk_level: 'High',
        status: 'Rejected',
        is_auto_approved: false,
      },
      {
        display_name: 'Lisa Anderson',
        id_type: 'Passport',
        match_score: 91,
        risk_level: 'Low',
        status: 'Approved',
        is_auto_approved: true,
      },
      {
        display_name: 'Robert Taylor',
        id_type: 'National ID',
        match_score: 78,
        risk_level: 'Medium',
        status: 'Pending',
        is_auto_approved: false,
      },
      {
        display_name: 'Maria Garcia',
        id_type: 'Passport',
        match_score: 94,
        risk_level: 'Low',
        status: 'Approved',
        is_auto_approved: true,
      },
      {
        display_name: 'John Smith',
        id_type: 'Driver License',
        match_score: 58,
        risk_level: 'High',
        status: 'Flagged',
        is_auto_approved: false,
      },
    ];

    const verificationIds: string[] = [];

    for (const verification of verifications) {
      const verificationId = uuidv4();
      verificationIds.push(verificationId);

      const createdAt = new Date();
      createdAt.setDate(createdAt.getDate() - Math.floor(Math.random() * 30));

      const verifiedAt = verification.status === 'Approved' || verification.status === 'Rejected'
        ? new Date(createdAt.getTime() + Math.random() * 3600000)
        : null;

      await client.query(
        `INSERT INTO verifications 
         (id, organization_id, user_id, display_name, id_type, match_score, risk_level, status, is_auto_approved, created_at, verified_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          verificationId,
          organizationId,
          userId,
          verification.display_name,
          verification.id_type,
          verification.match_score,
          verification.risk_level,
          verification.status,
          verification.is_auto_approved,
          createdAt,
          verifiedAt,
          verifiedAt || createdAt,
        ]
      );

      await client.query(
        `INSERT INTO verification_pii (verification_id, full_name, dob, id_number, address, document_images, extracted_fields)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          verificationId,
          verification.display_name,
          new Date(1980 + Math.floor(Math.random() * 30), Math.floor(Math.random() * 12), Math.floor(Math.random() * 28) + 1),
          `ID${Math.floor(Math.random() * 1000000)}`,
          `${Math.floor(Math.random() * 9999)} Main St, City, Country`,
          JSON.stringify({
            front: `https://example.com/docs/${verificationId}_front.jpg`,
            back: `https://example.com/docs/${verificationId}_back.jpg`,
          }),
          JSON.stringify({
            documentType: verification.id_type,
            issueDate: new Date(2020, 0, 1).toISOString(),
            expiryDate: new Date(2030, 11, 31).toISOString(),
          }),
        ]
      );

      const aiChecks = {
        liveness: verification.match_score > 85 ? 'pass' : 'fail',
        faceMatch: `${verification.match_score}%`,
        documentValid: verification.match_score > 70,
        ocrMatch: verification.match_score > 80,
      };

      const riskSignals = verification.risk_level === 'High' ? {
        suspiciousPatterns: ['document_quality_low', 'face_mismatch'],
        flags: ['manual_review_required'],
      } : {};

      await client.query(
        `INSERT INTO verification_ai_results (verification_id, provider, raw_response, checks, risk_signals)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          verificationId,
          'verifyx-ai',
          JSON.stringify({ processed: true, timestamp: new Date().toISOString() }),
          JSON.stringify(aiChecks),
          JSON.stringify(riskSignals),
        ]
      );
    }

    for (let i = 0; i < 5; i++) {
      const verificationId = verificationIds[Math.floor(Math.random() * verificationIds.length)];
      await client.query(
        `INSERT INTO audit_logs (id, user_id, organization_id, action, target_id, ip_address, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          uuidv4(),
          userId,
          organizationId,
          ['verification_viewed', 'verification_approved', 'verification_rejected', 'export_verifications', 'user_login'][i],
          verificationId,
          `192.168.1.${Math.floor(Math.random() * 255)}`,
          new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000),
        ]
      );
    }

    await client.query('COMMIT');
    console.log(`✓ Seeded ${verifications.length} verifications with PII and AI results`);
    console.log(`✓ Seeded 5 audit log entries`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('✗ Seed failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

const emailOrOrgId = process.argv[2];
seedData(emailOrOrgId).catch((error) => {
  console.error('Seed error:', error);
  process.exit(1);
});

