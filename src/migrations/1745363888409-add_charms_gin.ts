import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCharmsGin1745363888409 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        console.log('Adding GIN index to asset.keychains');
        await queryRunner.query(`DROP INDEX IF EXISTS "asset_charms_gin"`);
        await queryRunner.query(`CREATE INDEX "asset_charms_gin" ON "asset" USING GIN ("keychains")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        console.log('Dropping GIN index from asset.keychains');
        await queryRunner.query(`DROP INDEX IF EXISTS "asset_charms_gin"`);
    }

}
